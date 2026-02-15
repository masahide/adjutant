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
  type RequestWillBeSentEvent as IngressRequestWillBeSentEvent,
  type ResponseReceivedEvent as IngressResponseReceivedEvent,
  type WebSocketFrameEvent as IngressWebSocketFrameEvent,
} from "./slackIngressHandlers.js";
import { createSlackDebugTargets, hasSlackDebugTarget, SlackDebug } from "./slackDebug.js";

export type FetchPausedEvent = IngressFetchPausedEvent;
export type WebSocketFrameEvent = IngressWebSocketFrameEvent;
export type ResponseReceivedEvent = IngressResponseReceivedEvent;
export type RequestWillBeSentEvent = IngressRequestWillBeSentEvent;

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
        | "requestWillBeSent",
      handler: (
        payload: WebSocketFrameEvent | ResponseReceivedEvent | RequestWillBeSentEvent
      ) => unknown
    ): void;
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
  channelCachePath?: string;
  userCachePath?: string;
  debugFetchHookEnabled?: boolean;
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
const DOM_CAPTURE_DISABLED =
  (process.env.ADJUTANT_DISABLE_DOM_CAPTURE ?? "").toLowerCase() === "1" ||
  (process.env.ADJUTANT_DISABLE_DOM_CAPTURE ?? "").toLowerCase() === "true";

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
  private readonly domCaptureDisabled = DOM_CAPTURE_DISABLED;
  private readonly debugNetworkEvents = DEBUG_NETWORK_ENABLED;
  private readonly debugFetchEvents = DEBUG_FETCH_ENABLED;
  private readonly debugFetchHookEnabled: boolean;
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
    Network.on("requestWillBeSent", (payload) => {
      void this.ingressHandlers.handleRequestWillBeSent(payload as RequestWillBeSentEvent);
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
