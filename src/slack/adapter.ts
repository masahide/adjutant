import type { EmitFn, IngestionAdapter } from "../core/adapter.js";
import type { NormalizedEvent } from "../core/events.js";
import { SlackNameCacheRepository } from "./nameCacheRepository.js";
import { ResponseBodyReader } from "./responseBodyReader.js";
import { SlackResponseProjector } from "./responseProjector.js";
import {
  RuntimeContextRegistry,
  type RuntimeExecutionContextCreatedEvent,
  type RuntimeExecutionContextDestroyedEvent,
} from "./runtimeContextRegistry.js";
import { DomCaptureService, type ReactionDomCandidate } from "./domCaptureService.js";
import {
  SlackIngressHandlers,
  type FetchPausedEvent as IngressFetchPausedEvent,
  type RequestWillBeSentExtraInfoEvent as IngressRequestWillBeSentExtraInfoEvent,
  type RequestWillBeSentEvent as IngressRequestWillBeSentEvent,
  type ResponseReceivedEvent as IngressResponseReceivedEvent,
  type WebSocketFrameEvent as IngressWebSocketFrameEvent,
} from "./slackIngressHandlers.js";
import type { SlackAuthTokenCacheSnapshot } from "./slackAuthTokenCache.js";
import { createSlackDebugTargets, hasSlackDebugTarget, SlackDebug } from "./slackDebug.js";

export type FetchPausedEvent = IngressFetchPausedEvent;
export type WebSocketFrameEvent = IngressWebSocketFrameEvent;
export type ResponseReceivedEvent = IngressResponseReceivedEvent;
export type RequestWillBeSentEvent = IngressRequestWillBeSentEvent;
export type RequestWillBeSentExtraInfoEvent = IngressRequestWillBeSentExtraInfoEvent;

export type BrowserAuthTestAttempt = {
  contextId: number | null;
  ok: boolean;
  httpStatus?: number;
  slackOk?: boolean;
  workspaceKey?: string;
  origin?: string;
  href?: string;
  durationMs?: number;
  payload?: unknown;
  error?: string;
};

export type BrowserAuthTestResult = {
  ok: boolean;
  reason?: string;
  workspaceKey?: string;
  tokenSourceWorkspaceKey?: string;
  attempts: BrowserAuthTestAttempt[];
};

export type BrowserChannelListAttempt = {
  contextId: number | null;
  ok: boolean;
  httpStatus?: number;
  slackOk?: boolean;
  workspaceKey?: string;
  origin?: string;
  href?: string;
  durationMs?: number;
  channels?: Array<{
    id?: string;
    name?: string;
    isPrivate?: boolean;
    isIm?: boolean;
    isMpim?: boolean;
  }>;
  apiCalls?: Array<{
    endpoint?: string;
    httpStatus?: number;
    responseOk?: boolean;
    slackOk?: boolean;
    error?: string;
  }>;
  auth?: {
    teamId?: string;
    enterpriseId?: string;
    userId?: string;
    url?: string;
  };
  payload?: unknown;
  error?: string;
};

export type BrowserChannelListResult = {
  ok: boolean;
  reason?: string;
  workspaceKey?: string;
  tokenSourceWorkspaceKey?: string;
  attempts: BrowserChannelListAttempt[];
};

type SlackClient = {
  Fetch: {
    enable(opts: Record<string, unknown>): Promise<void>;
    on(name: "requestPaused", handler: (payload: FetchPausedEvent) => unknown): void;
    continueRequest(params: { requestId: string }): Promise<void>;
  };
  Network: {
    enable(opts: Record<string, unknown>): Promise<void>;
    setCacheDisabled(opts: { cacheDisabled: boolean }): Promise<void>;
    on(
      name:
        | "webSocketFrameReceived"
        | "webSocketFrameSent"
        | "responseReceived"
        | "requestWillBeSent"
        | "requestWillBeSentExtraInfo",
      handler: (
        payload:
          | WebSocketFrameEvent
          | ResponseReceivedEvent
          | RequestWillBeSentEvent
          | RequestWillBeSentExtraInfoEvent
      ) => unknown
    ): void;
    getCookies?: (params: { urls?: string[] }) => Promise<{
      cookies?: Array<{ name?: string; value?: string; domain?: string; path?: string }>;
    }>;
    getResponseBody(params: {
      requestId: string;
    }): Promise<{ body: string; base64Encoded: boolean }>;
  };
  Runtime: {
    enable(params: unknown): Promise<void>;
    on(
      name: "executionContextCreated" | "executionContextDestroyed",
      handler: (payload: unknown) => void
    ): void;
    evaluate(request: unknown): Promise<unknown>;
  };
};

type SlackAdapterDeps = {
  client: SlackClient;
  now?: () => Date;
  timezone?: string;
  domCaptureDisabled?: boolean;
  channelCachePath?: string;
  userCachePath?: string;
  debugFetchHookEnabled?: boolean;
  debugCookieStoreEnabled?: boolean;
  onDebugEvent?: (event: {
    source: "slack-adapter";
    kind: "raw_fetch" | "raw_ws" | "normalized";
    at: string;
    payload: unknown;
  }) => void;
};

const SLACK_API_RE = /https:\/\/[^/]+\.slack\.com\/api\/(chat\.postMessage|reactions\.[a-z]+)/i;

const DEBUG_TARGETS = createSlackDebugTargets();

const DOM_PROBE_DEBUG_ENABLED = DEBUG_TARGETS.has("slack:domprobe");
const DOM_VERBOSE_ENABLED = DEBUG_TARGETS.has("slack:domprobe");
const DEBUG_NETWORK_ENABLED = hasSlackDebugTarget(
  DEBUG_TARGETS,
  "slack:network",
  "slack:network:verbose"
);
const DEBUG_NOTIFICATION_ENABLED = hasSlackDebugTarget(
  DEBUG_TARGETS,
  "slack:notification",
  "slack:network:verbose"
);
const DEBUG_FETCH_ENABLED = hasSlackDebugTarget(
  DEBUG_TARGETS,
  "slack:fetch",
  "slack:network:verbose"
);
const DEBUG_FETCH_HOOK_ENABLED = hasSlackDebugTarget(
  DEBUG_TARGETS,
  "slack:fetch:hook",
  "slack:network:verbose"
);
const DEBUG_RUNTIME_ENABLED = hasSlackDebugTarget(
  DEBUG_TARGETS,
  "slack:runtime",
  "slack:runtime:verbose"
);

export class SlackAdapter implements IngestionAdapter {
  name = "slack";
  private readonly now: () => Date;
  private readonly timezone: string;
  private emit: EmitFn | null = null;
  private readonly cache: Map<string, { text?: string; user?: string; teamId?: string }> =
    new Map();
  private readonly seenUids: Set<string> = new Set();
  private readonly nameCacheRepository: SlackNameCacheRepository;
  private readonly responseBodyReader: ResponseBodyReader;
  private readonly responseProjector: SlackResponseProjector;
  private readonly slackDebug: SlackDebug;
  private readonly domCaptureService: DomCaptureService;
  private readonly ingressHandlers: SlackIngressHandlers;
  private readonly domProbeEnabled = DOM_PROBE_DEBUG_ENABLED;
  private readonly domDebugDetailed = DOM_VERBOSE_ENABLED;
  private readonly domCaptureDisabled: boolean;
  private readonly debugNetworkEvents = DEBUG_NETWORK_ENABLED;
  private readonly debugFetchEvents = DEBUG_FETCH_ENABLED;
  private readonly debugFetchHookEnabled: boolean;
  private readonly debugCookieStoreEnabled: boolean;
  private readonly debugRuntimeEvents = DEBUG_RUNTIME_ENABLED;
  private readonly runtimeContextRegistry = new RuntimeContextRegistry();
  private readonly onDebugEvent:
    | ((event: {
        source: "slack-adapter";
        kind: "raw_fetch" | "raw_ws" | "normalized";
        at: string;
        payload: unknown;
      }) => void)
    | undefined;
  constructor(private readonly deps: SlackAdapterDeps) {
    this.now = deps.now ?? (() => new Date());
    this.timezone = deps.timezone ?? "Asia/Tokyo";
    this.domCaptureDisabled = deps.domCaptureDisabled ?? false;
    this.nameCacheRepository = new SlackNameCacheRepository({
      channelCachePath: deps.channelCachePath,
      userCachePath: deps.userCachePath,
      now: this.now,
    });
    this.responseBodyReader = new ResponseBodyReader(this.deps.client);
    this.responseProjector = new SlackResponseProjector();
    this.slackDebug = new SlackDebug({
      prefix: "SlackAdapter",
      enabled: hasSlackDebugTarget(DEBUG_TARGETS, "slack", "slack:verbose", "slack:domprobe"),
      verboseEnabled: hasSlackDebugTarget(DEBUG_TARGETS, "slack:verbose"),
    });
    this.debugFetchHookEnabled = deps.debugFetchHookEnabled ?? DEBUG_FETCH_HOOK_ENABLED;
    this.debugCookieStoreEnabled = deps.debugCookieStoreEnabled ?? false;
    this.onDebugEvent = deps.onDebugEvent;
    this.domCaptureService = new DomCaptureService({
      disabled: this.domCaptureDisabled,
      debugDetailed: this.domDebugDetailed,
      resolveContextIds: (frameId) => this.runtimeContextRegistry.resolveContextIds(frameId),
      evaluateInContext: async (expression, contextId) => {
        const evalParams: Record<string, unknown> = {
          expression,
          returnByValue: true,
        };
        if (contextId !== null) evalParams.contextId = contextId;
        const result = (await this.deps.client.Runtime.evaluate(evalParams)) as {
          result?: { value?: unknown };
        };
        return result?.result?.value;
      },
      normalizedTimestamp: (ts) => this.normalizedTimestamp(ts),
      toText: (value) => this.asString(value),
      debugLog: (message, payload) =>
        this.slackDebug.debug(message, payload ? this.slackDebug.safePreview(payload) : payload),
      resolveChannelName: (channelId) => this.resolveChannelNameFromMap(channelId, undefined),
      cacheMessage: (channelId, ts, value) => {
        this.cacheMessage(channelId, ts, value);
      },
    });
    this.ingressHandlers = new SlackIngressHandlers({
      now: this.now,
      timezone: this.timezone,
      slackApiRe: SLACK_API_RE,
      debugFetchHookEnabled: this.debugFetchHookEnabled,
      debugCookieStoreEnabled: this.debugCookieStoreEnabled,
      debugNotificationEnabled: DEBUG_NOTIFICATION_ENABLED,
      slackDebug: this.slackDebug,
      pushDebugEvent: (kind, payload) => this.pushDebugEvent(kind, payload),
      truncateForDebug: (value, max) => this.truncateForDebug(value, max),
      domCapture: {
        capture: async (candidate) => this.captureDomCandidate(candidate),
        consume: (ts) => this.consumeDomCapture(ts),
      },
      cache: this.cache,
      cacheMessage: (channel, ts, value) => this.cacheMessage(channel, ts, value),
      cacheKey: (channel, ts) => this.cacheKey(channel, ts),
      resolveChannelNameFromMap: (channelId, teamIdHint) =>
        this.resolveChannelNameFromMap(channelId, teamIdHint),
      resolveTeamId: (teamIdHint, channelId) => this.resolveTeamId(teamIdHint, channelId),
      resolveUserNameFromMap: (userId, teamIdHint, channelIdHint) =>
        this.resolveUserNameFromMap(userId, teamIdHint, channelIdHint),
      nameCacheRepository: this.nameCacheRepository,
      responseBodyReader: this.responseBodyReader,
      responseProjector: this.responseProjector,
      readCookieStore: async (requestUrl) => this.readCookieStore(requestUrl),
    });
  }

  async start(emit: EmitFn): Promise<void> {
    this.emit = emit;
    const { Network, Fetch, Runtime } = this.deps.client;
    await this.nameCacheRepository.load();

    await Network.enable({});
    await Network.setCacheDisabled({ cacheDisabled: true });
    this.slackDebug.verbose("Network domain enabled");
    Network.on("webSocketFrameReceived", async (payload) => {
      if (this.debugNetworkEvents) {
        this.slackDebug.debug("webSocketFrameReceived", this.slackDebug.safePreview(payload));
      }
      const notifications = await this.ingressHandlers.handleWebSocketFrame(
        payload as WebSocketFrameEvent,
        "received"
      );
      for (const notification of notifications) {
        await this.deliver(notification, emit);
      }
    });
    Network.on("webSocketFrameSent", async (payload) => {
      if (this.debugNetworkEvents) {
        this.slackDebug.debug("webSocketFrameSent", this.slackDebug.safePreview(payload));
      }
      await this.ingressHandlers.handleWebSocketFrame(payload as WebSocketFrameEvent, "sent");
    });
    Network.on("responseReceived", async (payload) => {
      if (this.debugNetworkEvents) {
        this.slackDebug.debug("responseReceived", this.slackDebug.safePreview(payload));
      }
      await this.ingressHandlers.handleResponseReceived(payload as ResponseReceivedEvent);
    });
    Network.on("requestWillBeSent", async (payload) => {
      await this.ingressHandlers.handleRequestWillBeSent(payload as RequestWillBeSentEvent);
    });
    Network.on("requestWillBeSentExtraInfo", async (payload) => {
      await this.ingressHandlers.handleRequestWillBeSentExtraInfo(
        payload as RequestWillBeSentExtraInfoEvent
      );
    });

    if (typeof Runtime.on === "function") {
      Runtime.on("executionContextCreated", (payload) => {
        if (this.debugRuntimeEvents) {
          this.slackDebug.debug("executionContextCreated", this.slackDebug.safePreview(payload));
        }
        this.handleExecutionContextCreated(payload as RuntimeExecutionContextCreatedEvent);
      });
      Runtime.on("executionContextDestroyed", (payload) => {
        if (this.debugRuntimeEvents) {
          this.slackDebug.debug("executionContextDestroyed", this.slackDebug.safePreview(payload));
        }
        this.handleExecutionContextDestroyed(payload as RuntimeExecutionContextDestroyedEvent);
      });
    }
    if (typeof Runtime.enable === "function") {
      await Runtime.enable({});
      this.slackDebug.verbose("Runtime domain enabled");
    }
    if (this.domProbeEnabled) {
      void this.runDomProbe().catch((err) => {
        this.slackDebug.debug("dom probe failed", this.slackDebug.safePreview(err));
      });
    }

    await Fetch.enable({
      patterns: [
        { urlPattern: "*://*.slack.com/api/chat.postMessage*", requestStage: "Request" },
        { urlPattern: "*://*.slack.com/api/reactions.*", requestStage: "Request" },
      ],
    });
    this.slackDebug.verbose("Fetch domain enabled with patterns");

    Fetch.on("requestPaused", async (event: FetchPausedEvent) => {
      if (this.debugFetchEvents) {
        this.slackDebug.debug("requestPaused", this.slackDebug.safePreview(event));
      }
      try {
        const normalizedEvents = await this.ingressHandlers.handleRequest(event);
        for (const normalized of normalizedEvents) {
          await this.deliver(normalized, emit);
        }
      } finally {
        await Fetch.continueRequest({ requestId: event.requestId });
      }
    });
  }

  getAuthTokenSnapshot(workspaceKey: string): SlackAuthTokenCacheSnapshot | null {
    return this.ingressHandlers.getAuthTokenSnapshot(workspaceKey);
  }

  listAuthTokenSnapshots(): SlackAuthTokenCacheSnapshot[] {
    return this.ingressHandlers.listAuthTokenSnapshots();
  }

  async runBrowserAuthTest(input?: { workspaceKey?: string }): Promise<BrowserAuthTestResult> {
    const workspaceKey = this.asTrimmedString(input?.workspaceKey);
    const tokenInfo = this.resolveXoxcToken(workspaceKey);
    if (!tokenInfo) {
      return {
        ok: false,
        reason: "xoxc token is not available in auth token cache",
        workspaceKey,
        attempts: [],
      };
    }

    const expression = this.buildBrowserAuthTestExpression(tokenInfo.token);
    const attempts: BrowserAuthTestAttempt[] = [];
    const contextIds = this.runtimeContextRegistry.resolveContextIds();
    for (const contextId of contextIds) {
      try {
        const evalParams: Record<string, unknown> = {
          expression,
          returnByValue: true,
          awaitPromise: true,
        };
        if (contextId !== null) {
          evalParams.contextId = contextId;
        }
        const evaluated = (await this.deps.client.Runtime.evaluate(evalParams)) as {
          result?: { value?: unknown };
          exceptionDetails?: { text?: unknown };
        };
        const exceptionText = this.asTrimmedString(evaluated.exceptionDetails?.text);
        if (exceptionText) {
          attempts.push({
            contextId,
            ok: false,
            error: exceptionText,
          });
          continue;
        }
        const value = this.asRecord(evaluated.result?.value);
        if (!value) {
          attempts.push({
            contextId,
            ok: false,
            error: "runtime returned non-object value",
          });
          continue;
        }
        const attempt: BrowserAuthTestAttempt = {
          contextId,
          ok: value.ok === true,
          httpStatus: this.asFiniteNumber(value.httpStatus),
          slackOk: value.slackOk === true,
          workspaceKey: this.asTrimmedString(value.workspaceKey),
          origin: this.asTrimmedString(value.origin),
          href: this.asTrimmedString(value.href),
          durationMs: this.asFiniteNumber(value.durationMs),
          payload: value.payload,
          error: this.asTrimmedString(value.error),
        };
        attempts.push(attempt);
        if (attempt.ok) {
          return {
            ok: true,
            workspaceKey: workspaceKey ?? attempt.workspaceKey,
            tokenSourceWorkspaceKey: tokenInfo.workspaceKey,
            attempts,
          };
        }
      } catch (error) {
        attempts.push({
          contextId,
          ok: false,
          error: this.toErrorReason(error),
        });
      }
    }

    return {
      ok: false,
      reason: "no runtime context succeeded",
      workspaceKey,
      tokenSourceWorkspaceKey: tokenInfo.workspaceKey,
      attempts,
    };
  }

  async runBrowserChannelList(input?: {
    workspaceKey?: string;
    limit?: number;
  }): Promise<BrowserChannelListResult> {
    const workspaceKey = this.asTrimmedString(input?.workspaceKey);
    const tokenInfo = this.resolveXoxcToken(workspaceKey);
    if (!tokenInfo) {
      return {
        ok: false,
        reason: "xoxc token is not available in auth token cache",
        workspaceKey,
        attempts: [],
      };
    }

    const limit = this.normalizeChannelListLimit(input?.limit);
    const expression = this.buildBrowserChannelListExpression(tokenInfo.token, limit);
    const attempts: BrowserChannelListAttempt[] = [];
    const contextIds = this.runtimeContextRegistry.resolveContextIds();
    for (const contextId of contextIds) {
      try {
        const evalParams: Record<string, unknown> = {
          expression,
          returnByValue: true,
          awaitPromise: true,
        };
        if (contextId !== null) {
          evalParams.contextId = contextId;
        }
        const evaluated = (await this.deps.client.Runtime.evaluate(evalParams)) as {
          result?: { value?: unknown };
          exceptionDetails?: { text?: unknown };
        };
        const exceptionText = this.asTrimmedString(evaluated.exceptionDetails?.text);
        if (exceptionText) {
          attempts.push({
            contextId,
            ok: false,
            error: exceptionText,
          });
          continue;
        }
        const value = this.asRecord(evaluated.result?.value);
        if (!value) {
          attempts.push({
            contextId,
            ok: false,
            error: "runtime returned non-object value",
          });
          continue;
        }
        const channelsRaw = Array.isArray(value.channels) ? value.channels : [];
        const channels: Array<{
          id?: string;
          name?: string;
          isPrivate?: boolean;
          isIm?: boolean;
          isMpim?: boolean;
        }> = [];
        for (const item of channelsRaw) {
          const channel = this.asRecord(item);
          if (!channel) {
            continue;
          }
          channels.push({
            id: this.asTrimmedString(channel.id),
            name: this.asTrimmedString(channel.name),
            isPrivate: channel.isPrivate === true,
            isIm: channel.isIm === true,
            isMpim: channel.isMpim === true,
          });
        }
        const apiCallsRaw = Array.isArray(value.apiCalls) ? value.apiCalls : [];
        const apiCalls: Array<{
          endpoint?: string;
          httpStatus?: number;
          responseOk?: boolean;
          slackOk?: boolean;
          error?: string;
        }> = [];
        for (const item of apiCallsRaw) {
          const call = this.asRecord(item);
          if (!call) {
            continue;
          }
          apiCalls.push({
            endpoint: this.asTrimmedString(call.endpoint),
            httpStatus: this.asFiniteNumber(call.httpStatus),
            responseOk: call.responseOk === true,
            slackOk: call.slackOk === true,
            error: this.asTrimmedString(call.error),
          });
        }
        const auth = this.asRecord(value.auth);
        const attempt: BrowserChannelListAttempt = {
          contextId,
          ok: value.ok === true,
          httpStatus: this.asFiniteNumber(value.httpStatus),
          slackOk: value.slackOk === true,
          workspaceKey: this.asTrimmedString(value.workspaceKey),
          origin: this.asTrimmedString(value.origin),
          href: this.asTrimmedString(value.href),
          durationMs: this.asFiniteNumber(value.durationMs),
          channels,
          apiCalls,
          auth: auth
            ? {
                teamId: this.asTrimmedString(auth.teamId),
                enterpriseId: this.asTrimmedString(auth.enterpriseId),
                userId: this.asTrimmedString(auth.userId),
                url: this.asTrimmedString(auth.url),
              }
            : undefined,
          payload: value.payload,
          error: this.asTrimmedString(value.error),
        };
        attempts.push(attempt);
        if (attempt.ok) {
          return {
            ok: true,
            workspaceKey: workspaceKey ?? attempt.workspaceKey,
            tokenSourceWorkspaceKey: tokenInfo.workspaceKey,
            attempts,
          };
        }
      } catch (error) {
        attempts.push({
          contextId,
          ok: false,
          error: this.toErrorReason(error),
        });
      }
    }

    return {
      ok: false,
      reason: "no runtime context succeeded",
      workspaceKey,
      tokenSourceWorkspaceKey: tokenInfo.workspaceKey,
      attempts,
    };
  }

  async stop(): Promise<void> {
    this.emit = null;
  }

  private async captureDomCandidate(candidate: ReactionDomCandidate): Promise<void> {
    await this.domCaptureService.capture(candidate);
  }

  private consumeDomCapture(
    ts: string | undefined
  ): { text?: string; channelName?: string | null; channelId?: string | null } | null {
    return this.domCaptureService.consume(ts);
  }

  private async readCookieStore(
    requestUrl: string
  ): Promise<Array<{ name: string; value: string; domain?: string; path?: string }>> {
    const getCookies = this.deps.client.Network.getCookies;
    if (typeof getCookies !== "function") {
      throw new Error("Network.getCookies is unavailable");
    }
    const result = await getCookies({ urls: [requestUrl] });
    const cookies = Array.isArray(result?.cookies) ? result.cookies : [];
    return cookies
      .map((cookie) => ({
        name: this.asString(cookie?.name) ?? "",
        value: this.asString(cookie?.value) ?? "",
        domain: this.asString(cookie?.domain),
        path: this.asString(cookie?.path),
      }))
      .filter((cookie) => cookie.name.length > 0);
  }

  private cacheMessage(
    channel: string,
    ts: string,
    value: { text?: string | null; user?: string | null; teamId?: string | null }
  ): void {
    if (!channel || !ts) return;
    this.cache.set(this.cacheKey(channel, ts), {
      text: value.text ?? undefined,
      user: value.user ?? undefined,
      teamId: value.teamId ?? undefined,
    });
  }

  private resolveChannelNameFromMap(
    channelId: string | null | undefined,
    teamIdHint: string | undefined
  ): string | undefined {
    return this.nameCacheRepository.resolveChannelName(channelId, teamIdHint);
  }

  private resolveTeamId(
    teamIdHint: string | undefined,
    channelId: string | null | undefined
  ): string | undefined {
    return this.nameCacheRepository.resolveTeam(teamIdHint, channelId);
  }

  private resolveUserNameFromMap(
    userId: string | null | undefined,
    teamIdHint: string | undefined,
    channelIdHint?: string | null | undefined
  ): string | undefined {
    return this.nameCacheRepository.resolveUserName(userId, teamIdHint, channelIdHint);
  }

  private cacheKey(channel: string, ts: string): string {
    return `${channel}@${ts}`;
  }

  private async deliver(event: NormalizedEvent, emit: EmitFn): Promise<void> {
    if (!event || !event.uid) return;
    if (this.seenUids.has(event.uid)) return;
    this.seenUids.add(event.uid);
    this.pushDebugEvent("normalized", event);
    this.slackDebug.verbose("deliver", event);
    await emit(event);
  }

  private pushDebugEvent(kind: "raw_fetch" | "raw_ws" | "normalized", payload: unknown): void {
    if (!this.onDebugEvent) return;
    this.onDebugEvent({
      source: "slack-adapter",
      kind,
      at: new Date().toISOString(),
      payload: this.slackDebug.safePreview(payload),
    });
  }

  private truncateForDebug(value: string, max: number): string {
    if (!value || value.length <= max) return value;
    return `${value.slice(0, max)}...`;
  }

  private resolveXoxcToken(
    workspaceKey: string | undefined
  ): { workspaceKey: string; token: string } | null {
    const snapshots = this.ingressHandlers.listAuthTokenSnapshots();
    const candidates = snapshots
      .filter((snapshot) => {
        const token = this.asTrimmedString(snapshot.tokens.xoxc?.value);
        if (!token) {
          return false;
        }
        if (!workspaceKey) {
          return true;
        }
        return snapshot.workspaceKey === workspaceKey;
      })
      .sort((left, right) => {
        const leftSeen = this.asFiniteNumber(left.tokens.xoxc?.lastSeenAt) ?? 0;
        const rightSeen = this.asFiniteNumber(right.tokens.xoxc?.lastSeenAt) ?? 0;
        return rightSeen - leftSeen;
      });
    const selected = candidates[0];
    const token = this.asTrimmedString(selected?.tokens.xoxc?.value);
    if (!selected || !token) {
      return null;
    }
    return { workspaceKey: selected.workspaceKey, token };
  }

  private buildBrowserAuthTestExpression(xoxcToken: string): string {
    return `(() => {
      const token = ${JSON.stringify(xoxcToken)};
      const startedAt = Date.now();
      return (async () => {
        try {
          if (typeof fetch !== "function") {
            return { ok: false, error: "fetch is unavailable" };
          }
          const form = new URLSearchParams();
          form.set("token", token);
          const response = await fetch("/api/auth.test", {
            method: "POST",
            credentials: "include",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded; charset=utf-8"
            },
            body: form.toString()
          });
          const rawText = await response.text();
          let payload = null;
          try {
            payload = JSON.parse(rawText);
          } catch {
            payload = null;
          }
          return {
            ok: response.ok,
            httpStatus: response.status,
            slackOk: payload && payload.ok === true,
            workspaceKey:
              (payload && (payload.enterprise_id || payload.team_id)) ||
              undefined,
            origin: typeof location?.origin === "string" ? location.origin : undefined,
            href: typeof location?.href === "string" ? location.href : undefined,
            durationMs: Date.now() - startedAt,
            payload,
            error: payload && payload.ok === false ? payload.error : undefined,
          };
        } catch (err) {
          return {
            ok: false,
            error: String(err),
            durationMs: Date.now() - startedAt,
            origin: typeof location?.origin === "string" ? location.origin : undefined,
            href: typeof location?.href === "string" ? location.href : undefined,
          };
        }
      })();
    })()`;
  }

  private buildBrowserChannelListExpression(xoxcToken: string, limit: number): string {
    return `(() => {
      const token = ${JSON.stringify(xoxcToken)};
      const limit = ${JSON.stringify(limit)};
      const startedAt = Date.now();
      const apiCalls = [];
      const asObject = (value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          return null;
        }
        return value;
      };
      const asArray = (value) => (Array.isArray(value) ? value : []);
      const asTrimmedString = (value) => {
        if (typeof value !== "string") {
          return undefined;
        }
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : undefined;
      };
      const createUuid = () => {
        try {
          if (typeof crypto === "object" && crypto && typeof crypto.randomUUID === "function") {
            return crypto.randomUUID();
          }
        } catch {
          // no-op
        }
        return String(Date.now()) + "-" + Math.random().toString(16).slice(2);
      };
      const normalizeChannels = (items) => {
        const seen = new Set();
        const channels = [];
        for (const item of asArray(items)) {
          const channel = asObject(item);
          if (!channel) {
            continue;
          }
          const id = asTrimmedString(channel.id);
          const name = asTrimmedString(channel.name);
          if (!id || !name) {
            continue;
          }
          if (seen.has(id)) {
            continue;
          }
          const isPrivate =
            channel.is_private === true ||
            channel.isPrivate === true ||
            channel.is_group === true;
          const isIm = channel.is_im === true || channel.isIm === true;
          const isMpim = channel.is_mpim === true || channel.isMpim === true;
          const isArchived = channel.is_archived === true || channel.isArchived === true;
          if (isArchived || isIm || isMpim) {
            continue;
          }
          seen.add(id);
          channels.push({ id, name, isPrivate, isIm, isMpim });
          if (channels.length >= limit) {
            break;
          }
        }
        return channels;
      };
      const resolveWorkspaceKey = (payload) => {
        const record = asObject(payload);
        if (!record) {
          return undefined;
        }
        return asTrimmedString(record.enterprise_id) || asTrimmedString(record.team_id);
      };
      const postForm = async (path, params) => {
        const form = new URLSearchParams();
        form.set("token", token);
        const paramsObject = asObject(params);
        if (paramsObject) {
          for (const [key, value] of Object.entries(paramsObject)) {
            if (value === undefined || value === null) {
              continue;
            }
            form.set(key, String(value));
          }
        }
        const response = await fetch(path, {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded; charset=utf-8"
          },
          body: form.toString()
        });
        const rawText = await response.text();
        let payload = null;
        try {
          payload = JSON.parse(rawText);
        } catch {
          payload = null;
        }
        const payloadObject = asObject(payload);
        apiCalls.push({
          endpoint: path,
          httpStatus: response.status,
          responseOk: response.ok,
          slackOk: payloadObject ? payloadObject.ok === true : false,
          error:
            payloadObject && payloadObject.ok === false
              ? asTrimmedString(payloadObject.error)
              : undefined,
        });
        return {
          responseOk: response.ok,
          httpStatus: response.status,
          payload,
        };
      };
      return (async () => {
        try {
          if (typeof fetch !== "function") {
            return { ok: false, error: "fetch is unavailable", apiCalls };
          }

          const auth = await postForm("/api/auth.test", {});
          const authPayload = asObject(auth.payload);
          const authSlackOk = Boolean(authPayload && authPayload.ok === true);
          const authWorkspaceKey = resolveWorkspaceKey(authPayload);
          const enterpriseId = asTrimmedString(authPayload?.enterprise_id);
          const authContext = authPayload
            ? {
                teamId: asTrimmedString(authPayload.team_id),
                enterpriseId: asTrimmedString(authPayload.enterprise_id),
                userId: asTrimmedString(authPayload.user_id),
                url: asTrimmedString(authPayload.url),
              }
            : undefined;
          if (!auth.responseOk || !authSlackOk) {
            return {
              ok: false,
              httpStatus: auth.httpStatus,
              slackOk: authSlackOk,
              workspaceKey: authWorkspaceKey,
              origin: typeof location?.origin === "string" ? location.origin : undefined,
              href: typeof location?.href === "string" ? location.href : undefined,
              durationMs: Date.now() - startedAt,
              channels: [],
              payload: auth.payload,
              error: authPayload && authPayload.ok === false ? authPayload.error : "auth_test_failed",
              apiCalls,
              auth: authContext,
            };
          }

          if (enterpriseId) {
            const clientReqId = createUuid();
            const browseSessionId = createUuid();
            const enterpriseResponse = await postForm("/api/search.modules.channels", {
              module: "channels",
              query: "",
              page: "0",
              client_req_id: clientReqId,
              browse_session_id: browseSessionId,
              extracts: "0",
              highlight: "0",
              cursor: "*",
              extra_message_data: "0",
              no_user_profile: "1",
              count: String(limit),
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
            });
            const enterprisePayload = asObject(enterpriseResponse.payload);
            const enterpriseSlackOk = Boolean(
              enterpriseResponse.responseOk && enterprisePayload && enterprisePayload.ok === true
            );
            const channels = enterpriseSlackOk
              ? normalizeChannels(enterprisePayload.items)
              : [];
            return {
              ok: enterpriseSlackOk,
              httpStatus: enterpriseResponse.httpStatus,
              slackOk: enterpriseSlackOk,
              workspaceKey: authWorkspaceKey,
              origin: typeof location?.origin === "string" ? location.origin : undefined,
              href: typeof location?.href === "string" ? location.href : undefined,
              durationMs: Date.now() - startedAt,
              channels,
              payload: enterpriseResponse.payload,
              error:
                enterprisePayload && enterprisePayload.ok === false
                  ? enterprisePayload.error
                  : undefined,
              apiCalls,
              auth: authContext,
            };
          }

          const response = await postForm("/api/conversations.list", {
            limit: String(limit),
            exclude_archived: "true",
            types: "public_channel,private_channel",
          });
          const payload = asObject(response.payload);
          const slackOk = Boolean(response.responseOk && payload && payload.ok === true);
          const channels = slackOk ? normalizeChannels(payload.channels) : [];
          return {
            ok: slackOk,
            httpStatus: response.httpStatus,
            slackOk,
            workspaceKey: authWorkspaceKey || resolveWorkspaceKey(payload),
            origin: typeof location?.origin === "string" ? location.origin : undefined,
            href: typeof location?.href === "string" ? location.href : undefined,
            durationMs: Date.now() - startedAt,
            channels,
            payload: response.payload,
            error: payload && payload.ok === false ? payload.error : undefined,
            apiCalls,
            auth: authContext,
          };
        } catch (err) {
          return {
            ok: false,
            error: String(err),
            durationMs: Date.now() - startedAt,
            origin: typeof location?.origin === "string" ? location.origin : undefined,
            href: typeof location?.href === "string" ? location.href : undefined,
            apiCalls,
          };
        }
      })();
    })()`;
  }

  private normalizeChannelListLimit(value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return 10;
    }
    const normalized = Math.floor(value);
    return Math.max(1, Math.min(50, normalized));
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    return value as Record<string, unknown>;
  }

  private asTrimmedString(value: unknown): string | undefined {
    if (typeof value !== "string") {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private asFiniteNumber(value: unknown): number | undefined {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return undefined;
    }
    return Number(value);
  }

  private toErrorReason(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private asString(value: unknown): string | undefined {
    return typeof value === "string" && value !== "" ? value : undefined;
  }

  private normalizedTimestamp(ts: string | undefined): string | null {
    if (!ts) return null;
    const parsed = Number.parseFloat(ts);
    if (!Number.isFinite(parsed)) return null;
    const seconds = Math.floor(parsed);
    const micros = Math.round((parsed - seconds) * 1_000_000);
    return `${seconds}.${String(micros).padStart(6, "0")}`;
  }

  private handleExecutionContextCreated(event: RuntimeExecutionContextCreatedEvent): void {
    try {
      if (this.debugRuntimeEvents) {
        this.slackDebug.debug("executionContextCreated", this.slackDebug.safePreview(event));
      }
      this.runtimeContextRegistry.onCreated(event);
    } catch (err) {
      this.slackDebug.verbose("executionContextCreated error", err);
    }
  }

  private handleExecutionContextDestroyed(event: RuntimeExecutionContextDestroyedEvent): void {
    try {
      if (this.debugRuntimeEvents) {
        this.slackDebug.debug("executionContextDestroyed", this.slackDebug.safePreview(event));
      }
      this.runtimeContextRegistry.onDestroyed(event);
    } catch (err) {
      this.slackDebug.verbose("executionContextDestroyed error", err);
    }
  }

  private async runDomProbe(): Promise<void> {
    const expression = `(() => {
      try {
        if (typeof window !== "object") {
          return { ok: false, reason: "no-window" };
        }
        const ready = typeof document === "object" ? document.readyState : "unknown";
        const title = typeof document?.title === "string" ? document.title : null;
        const href = typeof window.location?.href === "string" ? window.location.href : null;
        const slackPresent = Boolean(window.TS);
        const timestamp = Date.now();
        window.__ADJUTANT_DOM_PROBE__ = { timestamp, ready };
        return {
          ok: true,
          ready,
          title,
          href,
          slackPresent,
          timestamp,
        };
      } catch (err) {
        return {
          ok: false,
          reason: String(err),
        };
      }
    })()`;
    for (const contextId of this.runtimeContextRegistry.resolveContextIds()) {
      try {
        const evalParams: Record<string, unknown> = {
          expression,
          returnByValue: true,
        };
        if (contextId !== null) evalParams.contextId = contextId;
        const result = (await this.deps.client.Runtime.evaluate(evalParams)) as {
          result?: { value?: unknown };
        };
        const value = result?.result?.value;
        this.slackDebug.debug("dom probe result", {
          contextId,
          value: this.slackDebug.safePreview(value),
        });
        if (value && typeof value === "object" && (value as { ok?: boolean }).ok) {
          return;
        }
      } catch (err) {
        this.slackDebug.debug("dom probe context error", {
          contextId,
          error: this.slackDebug.safePreview(err),
        });
      }
    }
  }
}
