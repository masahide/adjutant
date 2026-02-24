import type {
  SlackAuthResolved,
  SlackAuthTestResult,
  SlackChannel,
  SlackMode,
  SlackPostMessageResult,
  SlackSearchMessage,
  SlackUser,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 10_000;

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as JsonRecord;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function joinUrl(baseUrl: string, endpoint: string): string {
  const left = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const right = endpoint.startsWith("/") ? endpoint.slice(1) : endpoint;
  return `${left}/${right}`;
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

  if (slackError === "not_allowed_token_type" || slackError === "request_not_supported_for_team") {
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

function toChannel(item: unknown, teamId: string): SlackChannel | null {
  const record = asRecord(item);
  if (!record) {
    return null;
  }
  const id = asString(record.id);
  const name = asString(record.name);
  if (!id || !name) {
    return null;
  }
  return {
    id,
    name,
    teamId,
    isPrivate: Boolean(record.is_private),
    isIm: Boolean(record.is_im),
    isMpIm: Boolean(record.is_mpim),
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

export type SlackRouteClientOptions = {
  mode: SlackMode;
  apiBaseUrl: string;
  authProvider: { resolve: () => SlackAuthResolved | null };
  fetchFn?: typeof fetch;
  timeoutMs?: number;
};

export class SlackRouteClient {
  private readonly mode: SlackMode;
  private readonly apiBaseUrl: string;
  private readonly authProvider: { resolve: () => SlackAuthResolved | null };
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private authTestCache: SlackAuthTestResult | null = null;

  constructor(options: SlackRouteClientOptions) {
    this.mode = options.mode;
    this.apiBaseUrl = options.apiBaseUrl;
    this.authProvider = options.authProvider;
    this.fetchFn = options.fetchFn ?? fetch;
    this.timeoutMs =
      typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs)
        ? Math.max(1, Math.floor(options.timeoutMs))
        : DEFAULT_TIMEOUT_MS;
  }

  async authTest(): Promise<SlackAuthTestResult> {
    if (this.authTestCache) {
      return this.authTestCache;
    }
    const payload = await this.call("auth.test", {});
    const result: SlackAuthTestResult = {
      teamId: asString(payload.team_id),
      enterpriseId: asString(payload.enterprise_id),
      url: asString(payload.url),
      userId: asString(payload.user_id),
    };
    this.authTestCache = result;
    return result;
  }

  async listUsers(): Promise<SlackUser[]> {
    const info = await this.authTest();
    const teamId = info.teamId ?? info.enterpriseId ?? "global";
    const members = await this.collectPaginated("users.list", "members", {
      limit: "200",
      include_locale: "false",
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

  async listChannels(): Promise<SlackChannel[]> {
    const info = await this.authTest();
    const teamId = info.teamId ?? info.enterpriseId ?? "global";
    const channels = await this.collectPaginated("conversations.list", "channels", {
      limit: "200",
      exclude_archived: "true",
      types: "public_channel,private_channel,im,mpim",
    });
    const result: SlackChannel[] = [];
    for (const channel of channels) {
      const parsed = toChannel(channel, teamId);
      if (parsed) {
        result.push(parsed);
      }
    }
    return result;
  }

  async getUserInfo(userId: string): Promise<SlackUser | null> {
    const info = await this.authTest();
    const teamId = info.teamId ?? info.enterpriseId ?? "global";
    const payload = await this.call("users.info", { user: userId });
    return toUser(payload.user, teamId);
  }

  async getChannelInfo(channelId: string): Promise<SlackChannel | null> {
    const info = await this.authTest();
    const teamId = info.teamId ?? info.enterpriseId ?? "global";
    const payload = await this.call("conversations.info", { channel: channelId });
    return toChannel(payload.channel, teamId);
  }

  async searchMessages(query: string, limit = 20): Promise<{ messages: SlackSearchMessage[] }> {
    const payload = await this.call("search.messages", {
      query,
      count: String(Math.max(1, Math.min(200, Math.floor(limit)))),
      sort: "timestamp",
      sort_dir: "desc",
    });
    const messagesObject = asRecord(payload.messages);
    const matches = asArray(messagesObject?.matches);
    const messages: SlackSearchMessage[] = [];
    for (const entry of matches) {
      const parsed = toSearchMessage(entry);
      if (parsed) {
        messages.push(parsed);
      }
    }
    return { messages };
  }

  async postMessage(channelId: string, text: string): Promise<SlackPostMessageResult> {
    const payload = await this.call("chat.postMessage", {
      channel: channelId,
      text,
      as_user: "true",
    });
    const responseMessage = asRecord(payload.message);
    const resolvedChannelId = asString(payload.channel) ?? channelId;
    const ts = asString(payload.ts) ?? asString(responseMessage?.ts);
    if (!ts) {
      throw toRouteError({
        mode: this.mode,
        message: `missing ts in postMessage response (${this.mode})`,
      });
    }
    return {
      channelId: resolvedChannelId,
      ts,
      text: asString(responseMessage?.text) ?? text,
    };
  }

  private async collectPaginated(
    endpoint: string,
    field: string,
    baseParams: Record<string, string>
  ): Promise<unknown[]> {
    const result: unknown[] = [];
    let cursor: string | undefined;
    for (let index = 0; index < 50; index += 1) {
      const payload = await this.call(endpoint, {
        ...baseParams,
        cursor,
      });
      result.push(...asArray(payload[field]));
      const metadata = asRecord(payload.response_metadata);
      const nextCursor = asString(metadata?.next_cursor);
      if (!nextCursor) {
        break;
      }
      cursor = nextCursor;
    }
    return result;
  }

  private async call(
    endpoint: string,
    params: Record<string, string | undefined>
  ): Promise<JsonRecord> {
    const auth = this.authProvider.resolve();
    if (!auth) {
      throw new SlackRouteError({
        kind: "auth_invalid",
        mode: this.mode,
        message: `xoxc/xoxd token is missing (${this.mode})`,
      });
    }

    const form = new URLSearchParams();
    form.set("token", auth.xoxcToken);
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) {
        continue;
      }
      form.set(key, value);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    const url = joinUrl(this.apiBaseUrl, endpoint);
    try {
      const response = await this.fetchFn(url, {
        method: "POST",
        headers: {
          ...auth.defaultHeaders,
          "Content-Type": "application/x-www-form-urlencoded",
          "x-slack-route-mode": this.mode,
        },
        body: form.toString(),
        signal: controller.signal,
      });

      if (response.status === 429) {
        throw toRouteError({
          mode: this.mode,
          status: response.status,
          slackError: "ratelimited",
        });
      }

      const parsed = (await response.json().catch(() => null)) as unknown;
      const payload = asRecord(parsed);
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
    } finally {
      clearTimeout(timeout);
    }
  }
}
