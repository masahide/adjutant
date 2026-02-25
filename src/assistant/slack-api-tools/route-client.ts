import { randomUUID } from "node:crypto";
import { resolveEndpoint } from "../../runtime/config.js";
import { connectToSlackPage } from "../../runtime/slackConnection.js";
import {
  RuntimeContextRegistry,
  type RuntimeExecutionContextCreatedEvent,
  type RuntimeExecutionContextDestroyedEvent,
} from "../../slack/runtimeContextRegistry.js";
import type {
  SlackAuthResolved,
  SlackAuthTestResult,
  SlackChannel,
  SlackMode,
  SlackPostMessageResult,
  SlackSearchMessage,
  SlackUser,
} from "./types.js";
import {
  type JsonRecord,
  SlackApiSchemaError,
  parseClientCounts,
  parseClientUserBoot,
  parseConversationInfo,
  parseConversationsGenericInfo,
  parseConversationsList,
  parseImList,
  parsePostMessage,
  parseSearchMessages,
  parseSearchModulesChannels,
  parseUserInfo,
  parseUsersList,
} from "./response-parsers.js";

const DEFAULT_TIMEOUT_MS = 10_000;

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as JsonRecord;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return value;
}

export type SlackRouteErrorKind =
  | "auth_invalid"
  | "rate_limited"
  | "not_supported"
  | "not_found"
  | "timeout"
  | "network_error"
  | "api_error";

export class SlackRouteError extends Error {
  constructor(
    public readonly input: {
      kind: SlackRouteErrorKind;
      mode: SlackMode;
      message: string;
      slackError?: string;
      status?: number;
    }
  ) {
    super(input.message);
    this.name = "SlackRouteError";
  }

  get kind(): SlackRouteErrorKind {
    return this.input.kind;
  }

  get mode(): SlackMode {
    return this.input.mode;
  }

  get slackError(): string | undefined {
    return this.input.slackError;
  }

  get status(): number | undefined {
    return this.input.status;
  }
}

function toRouteError(input: {
  mode: SlackMode;
  status?: number;
  slackError?: string;
  message?: string;
}): SlackRouteError {
  const slackError = asString(input.slackError);
  const status = input.status;

  if (status === 429 || slackError === "ratelimited" || slackError === "rate_limited") {
    return new SlackRouteError({
      kind: "rate_limited",
      mode: input.mode,
      status,
      slackError,
      message: `rate limited (${input.mode})`,
    });
  }

  if (
    slackError === "not_allowed_token_type" ||
    slackError === "request_not_supported_for_team" ||
    slackError === "enterprise_is_restricted"
  ) {
    return new SlackRouteError({
      kind: "not_supported",
      mode: input.mode,
      status,
      slackError,
      message: `route not supported (${input.mode}): ${slackError}`,
    });
  }

  if (slackError === "channel_not_found" || slackError === "user_not_found") {
    return new SlackRouteError({
      kind: "not_found",
      mode: input.mode,
      status,
      slackError,
      message: `resource not found (${input.mode}): ${slackError}`,
    });
  }

  if (slackError === "invalid_auth" || slackError === "not_authed") {
    return new SlackRouteError({
      kind: "auth_invalid",
      mode: input.mode,
      status,
      slackError,
      message: `invalid auth (${input.mode}): ${slackError}`,
    });
  }

  return new SlackRouteError({
    kind: "api_error",
    mode: input.mode,
    status,
    slackError,
    message: input.message ?? `slack api failed (${input.mode})`,
  });
}

function toSchemaRouteError(
  mode: SlackMode,
  error: SlackApiSchemaError,
  status?: number
): SlackRouteError {
  return new SlackRouteError({
    kind: "api_error",
    mode,
    status,
    slackError: "schema_mismatch",
    message: `schema mismatch (${mode}) endpoint=${error.endpoint} key=${error.requiredKey} actual=${error.actualType}`,
  });
}

function toUser(item: unknown, teamId: string): SlackUser | null {
  const record = asRecord(item);
  if (!record) {
    return null;
  }
  const id = asString(record.id);
  const name = asString(record.name);
  if (!id || !name) {
    return null;
  }

  const profileRecord = asRecord(record.profile);
  const profile = profileRecord
    ? {
        displayName: asString(profileRecord.display_name),
        email: asString(profileRecord.email),
        firstName: asString(profileRecord.first_name),
        lastName: asString(profileRecord.last_name),
        imageOriginal: asString(profileRecord.image_original),
      }
    : undefined;

  return {
    id,
    name,
    realName: asString(record.real_name),
    teamId,
    profile,
  };
}

type ParsedChannel = {
  channel: SlackChannel;
  isArchived: boolean;
};

function toChannel(item: unknown, teamId: string): ParsedChannel | null {
  const record = asRecord(item);
  if (!record) {
    return null;
  }
  const id = asString(record.id);
  if (!id) {
    return null;
  }
  const name =
    asString(record.name) ?? asString(record.name_normalized) ?? asString(record.user) ?? id;

  return {
    channel: {
      id,
      name,
      teamId,
      isPrivate: Boolean(record.is_private) || Boolean(record.isPrivate),
      isIm: Boolean(record.is_im) || Boolean(record.isIm),
      isMpIm: Boolean(record.is_mpim) || Boolean(record.isMpim),
    },
    isArchived: Boolean(record.is_archived) || Boolean(record.isArchived),
  };
}

function toSearchMessage(item: unknown): SlackSearchMessage | null {
  const record = asRecord(item);
  if (!record) {
    return null;
  }
  const channel = asRecord(record.channel);
  const channelId = asString(channel?.id) ?? asString(record.channel_id);
  const ts = asString(record.ts);
  if (!channelId || !ts) {
    return null;
  }
  return {
    channelId,
    ts,
    userId: asString(record.user),
    text: asString(record.text),
  };
}

function normalizeEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim();
  if (trimmed.startsWith("/")) {
    return trimmed;
  }
  return `/api/${trimmed}`;
}

function createBrowserApiExpression(input: {
  endpoint: string;
  token: string;
  params: Record<string, string | undefined>;
  timeoutMs: number;
}): string {
  const endpointPath = normalizeEndpoint(input.endpoint);
  const entries = Object.entries(input.params)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([key, value]) => [key, value]);

  return `(() => {
    const endpoint = ${JSON.stringify(endpointPath)};
    const token = ${JSON.stringify(input.token)};
    const timeoutMs = ${JSON.stringify(input.timeoutMs)};
    const entries = ${JSON.stringify(entries)};
    const startedAt = Date.now();
    return (async () => {
      try {
        if (typeof fetch !== "function") {
          return { ok: false, error: "fetch is unavailable" };
        }
        const form = new URLSearchParams();
        form.set("token", token);
        for (const entry of entries) {
          if (!Array.isArray(entry) || entry.length < 2) {
            continue;
          }
          form.set(String(entry[0]), String(entry[1]));
        }

        let controller = null;
        let timer = null;
        if (typeof AbortController === "function") {
          controller = new AbortController();
          timer = setTimeout(() => {
            try {
              controller.abort();
            } catch {
              // no-op
            }
          }, Math.max(1, timeoutMs));
        }

        try {
          const response = await fetch(endpoint, {
            method: "POST",
            credentials: "include",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded; charset=utf-8"
            },
            body: form.toString(),
            signal: controller ? controller.signal : undefined,
          });
          const rawText = await response.text();
          let payload = null;
          try {
            payload = JSON.parse(rawText);
          } catch {
            payload = null;
          }
          return {
            ok: true,
            responseOk: response.ok,
            httpStatus: response.status,
            payload,
            origin: typeof location?.origin === "string" ? location.origin : undefined,
            href: typeof location?.href === "string" ? location.href : undefined,
            durationMs: Date.now() - startedAt,
          };
        } finally {
          if (timer !== null) {
            clearTimeout(timer);
          }
        }
      } catch (err) {
        const message = String(err);
        const lowered = message.toLowerCase();
        const timeout = lowered.includes("aborted") || lowered.includes("timeout");
        return {
          ok: false,
          error: message,
          timeout,
          origin: typeof location?.origin === "string" ? location.origin : undefined,
          href: typeof location?.href === "string" ? location.href : undefined,
          durationMs: Date.now() - startedAt,
        };
      }
    })();
  })()`;
}

export type SlackBrowserApiCallInput = {
  mode: SlackMode;
  endpoint: string;
  params: Record<string, string | undefined>;
  workspaceKey?: string;
  auth: SlackAuthResolved;
  timeoutMs: number;
};

export type SlackBrowserApiCallResult = {
  status?: number;
  payload?: unknown;
};

export type SlackBrowserApiInvoker = (
  input: SlackBrowserApiCallInput
) => Promise<SlackBrowserApiCallResult>;

function createDefaultBrowserApiInvoker(input: {
  host: string;
  port: number;
}): SlackBrowserApiInvoker {
  return async (callInput) => {
    const { client } = await connectToSlackPage(input.host, input.port);
    const runtimeRegistry = new RuntimeContextRegistry();
    const onCreated = (event: unknown) => {
      runtimeRegistry.onCreated(event as RuntimeExecutionContextCreatedEvent);
    };
    const onDestroyed = (event: unknown) => {
      runtimeRegistry.onDestroyed(event as RuntimeExecutionContextDestroyedEvent);
    };
    client.Runtime.on("executionContextCreated", onCreated);
    client.Runtime.on("executionContextDestroyed", onDestroyed);

    try {
      await client.Runtime.enable();
      await new Promise<void>((resolve) => setTimeout(resolve, 20));

      const expression = createBrowserApiExpression({
        endpoint: callInput.endpoint,
        token: callInput.auth.xoxcToken,
        params: callInput.params,
        timeoutMs: callInput.timeoutMs,
      });

      const contextIds = runtimeRegistry.resolveContextIds();
      let firstFailure: {
        status?: number;
        payload?: unknown;
        timeout?: boolean;
        error?: string;
      } | null = null;

      for (const contextId of contextIds) {
        const evaluateParams: Record<string, unknown> = {
          expression,
          returnByValue: true,
          awaitPromise: true,
        };
        if (contextId !== null) {
          evaluateParams.contextId = contextId;
        }

        const evaluated = (await client.Runtime.evaluate(evaluateParams as never)) as {
          result?: { value?: unknown };
          exceptionDetails?: { text?: unknown };
        };
        const exceptionText = asString(evaluated.exceptionDetails?.text);
        if (exceptionText) {
          if (!firstFailure) {
            firstFailure = { error: exceptionText };
          }
          continue;
        }

        const value = asRecord(evaluated.result?.value);
        if (!value) {
          if (!firstFailure) {
            firstFailure = { error: "runtime returned non-object value" };
          }
          continue;
        }

        if (value.ok === true) {
          return {
            status: asFiniteNumber(value.httpStatus),
            payload: value.payload,
          };
        }

        const failure = {
          status: asFiniteNumber(value.httpStatus),
          payload: value.payload,
          timeout: value.timeout === true,
          error: asString(value.error),
        };
        if (!firstFailure) {
          firstFailure = failure;
        }
        if (failure.timeout) {
          const timeoutError = new Error(failure.error ?? "cdp browser fetch timeout");
          timeoutError.name = "AbortError";
          throw timeoutError;
        }
      }

      if (firstFailure) {
        if (firstFailure.timeout) {
          const timeoutError = new Error(firstFailure.error ?? "cdp browser fetch timeout");
          timeoutError.name = "AbortError";
          throw timeoutError;
        }
        return {
          status: firstFailure.status,
          payload: firstFailure.payload,
        };
      }

      throw new Error("cdp runtime context is unavailable");
    } finally {
      try {
        await client.close();
      } catch {
        // no-op
      }
    }
  };
}

export type SlackRouteClientOptions = {
  mode: SlackMode;
  authProvider: { resolve: (workspaceKey?: string) => SlackAuthResolved | null };
  timeoutMs?: number;
  requestEnabled?: boolean;
  cdpHost?: string;
  cdpPort?: number;
  browserInvoker?: SlackBrowserApiInvoker;
};

export class SlackRouteClient {
  private readonly mode: SlackMode;
  private readonly authProvider: { resolve: (workspaceKey?: string) => SlackAuthResolved | null };
  private readonly timeoutMs: number;
  private readonly requestEnabled: boolean;
  private readonly browserInvoker: SlackBrowserApiInvoker;
  private readonly authTestCache = new Map<string, SlackAuthTestResult>();

  constructor(options: SlackRouteClientOptions) {
    this.mode = options.mode;
    this.authProvider = options.authProvider;
    this.timeoutMs =
      typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs)
        ? Math.max(1, Math.floor(options.timeoutMs))
        : DEFAULT_TIMEOUT_MS;
    this.requestEnabled = options.requestEnabled !== false;

    if (options.browserInvoker) {
      this.browserInvoker = options.browserInvoker;
    } else {
      const endpoint = resolveEndpoint();
      this.browserInvoker = createDefaultBrowserApiInvoker({
        host: asString(options.cdpHost) ?? endpoint.host,
        port:
          typeof options.cdpPort === "number" && Number.isFinite(options.cdpPort)
            ? Math.max(1, Math.floor(options.cdpPort))
            : endpoint.port,
      });
    }
  }

  async authTest(workspaceKey?: string): Promise<SlackAuthTestResult> {
    const cacheKey = asString(workspaceKey) ?? "__latest__";
    const cached = this.authTestCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const auth = this.authProvider.resolve(workspaceKey);
    if (!auth) {
      throw new SlackRouteError({
        kind: "auth_invalid",
        mode: this.mode,
        message: `xoxc/xoxd token is missing (${this.mode})`,
      });
    }

    const workspaceHint = asString(auth.workspaceKey);
    const payload = {
      team_id: auth.authTest?.teamId ?? workspaceHint,
      enterprise_id: auth.authTest?.enterpriseId,
      url: auth.authTest?.url,
      user_id: auth.authTest?.userId,
    } satisfies Record<string, unknown>;
    const result: SlackAuthTestResult = {
      teamId: asString(payload.team_id),
      enterpriseId: asString(payload.enterprise_id),
      url: asString(payload.url),
      userId: asString(payload.user_id),
    };
    this.authTestCache.set(cacheKey, result);
    return result;
  }

  async listUsers(workspaceKey?: string): Promise<SlackUser[]> {
    const info = await this.authTest(workspaceKey);
    const teamId = info.teamId ?? info.enterpriseId ?? "global";
    const members = await this.collectPaginated({
      endpoint: "users.list",
      baseParams: {
        limit: "200",
        include_locale: "false",
      },
      workspaceKey,
      parsePage: (payload) => {
        const parsed = this.parseContract(() => parseUsersList(payload));
        return {
          items: parsed.members,
          nextCursor: parsed.nextCursor,
        };
      },
    });
    const users: SlackUser[] = [];
    for (const member of members) {
      const parsed = toUser(member, teamId);
      if (parsed) {
        users.push(parsed);
      }
    }
    return users;
  }

  async listChannels(workspaceKey?: string): Promise<SlackChannel[]> {
    const info = await this.authTest(workspaceKey);
    const teamId = info.teamId ?? info.enterpriseId ?? "global";
    const shouldUseEnterpriseRoute = this.mode === "enterprise" || Boolean(info.enterpriseId);

    if (shouldUseEnterpriseRoute) {
      return this.collectEnterpriseChannels({
        workspaceKey,
        teamId,
      });
    }

    const channels = await this.collectPaginated({
      endpoint: "conversations.list",
      baseParams: {
        limit: "200",
        exclude_archived: "true",
        types: "public_channel,private_channel,im,mpim",
      },
      workspaceKey,
      parsePage: (payload) => {
        const parsed = this.parseContract(() => parseConversationsList(payload));
        return {
          items: parsed.channels,
          nextCursor: parsed.nextCursor,
        };
      },
    });
    const result: SlackChannel[] = [];
    for (const channel of channels) {
      const parsed = toChannel(channel, teamId);
      if (!parsed || parsed.isArchived) {
        continue;
      }
      result.push(parsed.channel);
    }
    return result;
  }

  async getUserInfo(userId: string, workspaceKey?: string): Promise<SlackUser | null> {
    const info = await this.authTest(workspaceKey);
    const teamId = info.teamId ?? info.enterpriseId ?? "global";
    const payload = await this.call("users.info", { user: userId }, workspaceKey);
    const parsed = this.parseContract(() => parseUserInfo(payload));
    return toUser(parsed.user, teamId);
  }

  async getChannelInfo(channelId: string, workspaceKey?: string): Promise<SlackChannel | null> {
    const info = await this.authTest(workspaceKey);
    const teamId = info.teamId ?? info.enterpriseId ?? "global";
    const shouldUseEnterpriseRoute = this.mode === "enterprise" || Boolean(info.enterpriseId);
    if (shouldUseEnterpriseRoute) {
      const payload = await this.call(
        "conversations.genericInfo",
        {
          updated_channels: JSON.stringify({ [channelId]: 0 }),
          _x_reason: "fallback:UnknownFetchManager",
          _x_mode: "online",
          _x_sonic: "true",
          _x_app_name: "client",
        },
        workspaceKey
      );
      const parsedPayload = this.parseContract(() => parseConversationsGenericInfo(payload));
      const channel = toChannel(parsedPayload.channels[0], teamId);
      if (!channel || channel.isArchived) {
        return null;
      }
      return channel.channel;
    }

    const payload = await this.call("conversations.info", { channel: channelId }, workspaceKey);
    const parsedPayload = this.parseContract(() => parseConversationInfo(payload));
    const channel = toChannel(parsedPayload.channel, teamId);
    if (!channel || channel.isArchived) {
      return null;
    }
    return channel.channel;
  }

  async searchMessages(
    query: string,
    limit = 20,
    workspaceKey?: string
  ): Promise<{ messages: SlackSearchMessage[] }> {
    const payload = await this.call(
      "search.messages",
      {
        query,
        count: String(Math.max(1, Math.min(200, Math.floor(limit)))),
        page: "1",
      },
      workspaceKey
    );
    const parsedPayload = this.parseContract(() => parseSearchMessages(payload));
    const messages: SlackSearchMessage[] = [];
    for (const entry of parsedPayload.matches) {
      const parsed = toSearchMessage(entry);
      if (parsed) {
        messages.push(parsed);
      }
    }
    return { messages };
  }

  async postMessage(
    channelId: string,
    text: string,
    workspaceKey?: string
  ): Promise<SlackPostMessageResult> {
    const payload = await this.call(
      "chat.postMessage",
      {
        channel: channelId,
        text,
      },
      workspaceKey
    );
    const parsedPayload = this.parseContract(() => parsePostMessage(payload));
    const responseMessage = asRecord(payload.message);
    return {
      channelId: parsedPayload.channel,
      ts: parsedPayload.ts,
      text: asString(responseMessage?.text) ?? text,
    };
  }

  private async collectEnterpriseChannels(input: {
    workspaceKey?: string;
    teamId: string;
  }): Promise<SlackChannel[]> {
    const channels: SlackChannel[] = [];
    const seen = new Set<string>();

    const appendChannels = (items: unknown[]): void => {
      for (const item of items) {
        const parsed = toChannel(item, input.teamId);
        if (!parsed || parsed.isArchived || seen.has(parsed.channel.id)) {
          continue;
        }
        seen.add(parsed.channel.id);
        channels.push(parsed.channel);
      }
    };

    const nowSeconds = Math.floor(Date.now() / 1000);
    const userBootPayload = await this.call(
      "client.userBoot",
      {
        include_min_version_bump_check: "1",
        version_ts: String(nowSeconds + 86_400),
        build_version_ts: String(nowSeconds + 86_400),
        _x_reason: "initial-data",
        _x_mode: "online",
        _x_sonic: "true",
        _x_app_name: "client",
      },
      input.workspaceKey
    );
    const userBoot = this.parseContract(() => parseClientUserBoot(userBootPayload));
    appendChannels(userBoot.channels);
    appendChannels(userBoot.ims);

    const ims = await this.collectPaginated({
      endpoint: "im.list",
      baseParams: {
        get_latest: "true",
        get_read_state: "true",
        _x_reason: "guided-search-people-empty-state",
        _x_mode: "online",
        _x_sonic: "true",
        _x_app_name: "client",
      },
      workspaceKey: input.workspaceKey,
      parsePage: (payload) => {
        const parsed = this.parseContract(() => parseImList(payload));
        return {
          items: parsed.ims,
          nextCursor: parsed.nextCursor,
        };
      },
      initialCursor: "",
    });
    appendChannels(ims);

    const searched = await this.collectSearchModuleChannels(input.workspaceKey, 100);
    appendChannels(searched);

    const countsPayload = await this.call(
      "client.counts",
      {
        thread_counts_by_channel: "true",
        org_wide_aware: "true",
        include_file_channels: "true",
        _x_reason: "client-counts-api/fetchClientCounts",
        _x_mode: "online",
        _x_sonic: "true",
        _x_app_name: "client",
      },
      input.workspaceKey
    );
    const counts = this.parseContract(() => parseClientCounts(countsPayload));
    appendChannels(counts.channels);
    appendChannels(counts.ims);

    const updatedChannels = Object.fromEntries(
      counts.mpims
        .map((item) => asRecord(item))
        .map((record) => asString(record?.id))
        .filter((id): id is string => typeof id === "string" && id.length > 0 && !seen.has(id))
        .map((id) => [id, 0])
    );
    const genericPayload = await this.call(
      "conversations.genericInfo",
      {
        updated_channels: JSON.stringify(updatedChannels),
        _x_reason: "fallback:UnknownFetchManager",
        _x_mode: "online",
        _x_sonic: "true",
        _x_app_name: "client",
      },
      input.workspaceKey
    );
    const generic = this.parseContract(() => parseConversationsGenericInfo(genericPayload));
    appendChannels(generic.channels);
    return channels;
  }

  private async collectSearchModuleChannels(
    workspaceKey: string | undefined,
    count: number
  ): Promise<unknown[]> {
    const result: unknown[] = [];
    let cursor: string | undefined;
    const browseSessionId = randomUUID();

    for (let index = 0; index < 50; index += 1) {
      const payload = await this.call(
        "search.modules.channels",
        {
          module: "channels",
          query: "",
          page: "0",
          client_req_id: randomUUID(),
          browse_session_id: browseSessionId,
          extracts: "0",
          highlight: "0",
          cursor: cursor ?? "*",
          extra_message_data: "0",
          no_user_profile: "1",
          count: String(Math.max(1, Math.min(500, count))),
          file_title_only: "false",
          query_rewrite_disabled: "false",
          include_files_shares: "1",
          browse: "standard",
          search_context: "desktop_channel_browser",
          max_filter_suggestions: "10",
          sort: "name",
          sort_dir: "asc",
          channel_type: "",
          exclude_my_channels: "0",
          search_only_my_channels: "false",
          recommend_source: "channel-browser",
          _x_reason: "browser-query",
          _x_mode: "online",
          _x_sonic: "true",
          _x_app_name: "client",
        },
        workspaceKey
      );
      const parsed = this.parseContract(() => parseSearchModulesChannels(payload));
      result.push(...parsed.items);
      const nextCursor = parsed.nextCursor;
      if (!nextCursor) {
        break;
      }
      cursor = nextCursor;
    }

    return result;
  }

  private async collectPaginated(input: {
    endpoint: string;
    baseParams: Record<string, string>;
    workspaceKey?: string;
    parsePage: (payload: JsonRecord) => { items: unknown[]; nextCursor?: string };
    initialCursor?: string;
  }): Promise<unknown[]> {
    const result: unknown[] = [];
    let cursor: string | undefined = input.initialCursor;
    for (let index = 0; index < 50; index += 1) {
      const payload = await this.call(
        input.endpoint,
        {
          ...input.baseParams,
          cursor,
        },
        input.workspaceKey
      );
      const parsed = input.parsePage(payload);
      result.push(...parsed.items);
      const nextCursor = parsed.nextCursor;
      if (!nextCursor) {
        break;
      }
      cursor = nextCursor;
    }
    return result;
  }

  private parseContract<T>(execute: () => T): T {
    try {
      return execute();
    } catch (error) {
      if (error instanceof SlackApiSchemaError) {
        throw toSchemaRouteError(this.mode, error);
      }
      throw error;
    }
  }

  private async call(
    endpoint: string,
    params: Record<string, string | undefined>,
    workspaceKey?: string
  ): Promise<JsonRecord> {
    if (!this.requestEnabled) {
      throw new SlackRouteError({
        kind: "not_supported",
        mode: this.mode,
        message: `slack api request is disabled (${this.mode})`,
      });
    }
    const auth = this.authProvider.resolve(workspaceKey);
    if (!auth) {
      throw new SlackRouteError({
        kind: "auth_invalid",
        mode: this.mode,
        message: `xoxc/xoxd token is missing (${this.mode})`,
      });
    }

    try {
      const response = await this.browserInvoker({
        mode: this.mode,
        endpoint,
        params,
        workspaceKey,
        auth,
        timeoutMs: this.timeoutMs,
      });

      if (response.status === 429) {
        throw toRouteError({
          mode: this.mode,
          status: response.status,
          slackError: "ratelimited",
        });
      }

      const payload = asRecord(response.payload);
      if (!payload) {
        throw toRouteError({
          mode: this.mode,
          status: response.status,
          message: `invalid JSON response (${this.mode})`,
        });
      }

      if (payload.ok !== true) {
        throw toRouteError({
          mode: this.mode,
          status: response.status,
          slackError: asString(payload.error),
          message: `slack error response (${this.mode})`,
        });
      }

      return payload;
    } catch (error) {
      if (error instanceof SlackRouteError) {
        throw error;
      }
      if (error instanceof Error && error.name === "AbortError") {
        throw new SlackRouteError({
          kind: "timeout",
          mode: this.mode,
          message: `timeout (${this.mode})`,
        });
      }
      throw new SlackRouteError({
        kind: "network_error",
        mode: this.mode,
        message: error instanceof Error ? error.message : `network error (${this.mode})`,
      });
    }
  }
}
