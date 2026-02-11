import type { EmitFn, IngestionAdapter } from "../core/adapter.js";
import type { NormalizedEvent } from "../core/events.js";
import {
  normalizeSlackMessage,
  normalizeSlackReaction,
  type NormalizeOptions,
} from "./normalize.js";
import { fromBlocks } from "./blocks.js";

export type FetchPausedEvent = {
  requestId: string;
  frameId?: string;
  request: {
    url: string;
    method: string;
    headers?: Record<string, string>;
    postData?: string;
  };
};
export type WebSocketFrameEvent = {
  response: { payloadData: string };
};
export type ResponseReceivedEvent = {
  requestId: string;
  response: { url: string };
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
      name: "webSocketFrameReceived" | "webSocketFrameSent" | "responseReceived",
      handler: (payload: WebSocketFrameEvent | ResponseReceivedEvent) => unknown
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
};

const SLACK_API_RE = /https:\/\/[^/]+\.slack\.com\/api\/(chat\.postMessage|reactions\.[a-z]+)/i;

const DEBUG_TOKENS = (process.env.REACLOG_DEBUG ?? "")
  .split(",")
  .map((token) => token.trim())
  .filter((token) => token.length > 0);

const DEBUG_TARGETS = new Set(DEBUG_TOKENS);

const DOM_PROBE_DEBUG_ENABLED = DEBUG_TARGETS.has("slack:domprobe");
const DOM_VERBOSE_ENABLED = DEBUG_TARGETS.has("slack:domprobe");
const DEBUG_NETWORK_ENABLED =
  DEBUG_TARGETS.has("slack:network") || DEBUG_TARGETS.has("slack:network:verbose");
const DEBUG_FETCH_ENABLED =
  DEBUG_TARGETS.has("slack:fetch") || DEBUG_TARGETS.has("slack:network:verbose");
const DEBUG_RUNTIME_ENABLED =
  DEBUG_TARGETS.has("slack:runtime") || DEBUG_TARGETS.has("slack:runtime:verbose");
const DOM_CAPTURE_DISABLED =
  (process.env.REACLOG_DISABLE_DOM_CAPTURE ?? "").toLowerCase() === "1" ||
  (process.env.REACLOG_DISABLE_DOM_CAPTURE ?? "").toLowerCase() === "true";

const REACTION_PAYLOAD_KEYS = [
  "reaction_added",
  "reaction_removed",
  "reactions.add",
  "reactions.remove",
];

const DOM_ROOT_SELECTORS = [
  "[data-message-ts]",
  "[data-message-id]",
  '[data-qa="message"]',
  '[data-qa="message_container"]',
  '[data-qa="virtual-list-item"]',
  "[data-qa='message-pane-body'] [role='row']",
  ".p-message_pane_message",
  ".c-message_kit__message",
  ".p-threads_view__thread_container [role='presentation']",
];

const DOM_BODY_SELECTORS = [
  '[data-qa="message_content"]',
  '[data-qa="message-text"]',
  ".p-rich_text_section",
  ".c-message__body",
  ".p-message_pane_message__message",
  ".p-threads_view__thread_message_body",
  ".c-message_kit__text",
  ".p-rich_text_block",
];

const DOM_CHANNEL_NAME_SELECTORS = [
  '[data-qa="channel_name_text"]',
  ".p-top_nav__channel_header__name",
  ".p-top_nav__conversation_title__name",
  ".p-classic_nav__model__title__name",
  ".p-ia__channel_header__info .p-ia__channel_header__name",
  ".p-workspace_name",
  "[data-qa='channel_context_bar_channel_name']",
];

const DOM_RETRY_DELAYS_MS = [0, 100, 200, 300] as const;
const DOM_EXCERPT_LENGTH = 80;
const DOM_CACHE_MAX_ENTRIES = 200;

const DOM_CAPTURE_SCRIPT = `(function reaclogCapture(tsList, selectors, debugMode) {
  try {
    const toArray = (value) => {
      if (Array.isArray(value)) return value;
      return value == null ? [] : [value];
    };
    const needles = toArray(tsList)
      .map((value) => (typeof value === "string" ? value : String(value ?? "")))
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    if (needles.length === 0) {
      return { status: "no-ts" };
    }
    const rootSelectors = Array.isArray(selectors?.root) ? selectors.root : [];
    const bodySelectors = Array.isArray(selectors?.body) ? selectors.body : [];
    const channelSelectors = Array.isArray(selectors?.channel) ? selectors.channel : [];
    const nodes = [];
    const seen = new Set();
    const pushNode = (node) => {
      if (!node || typeof node !== "object") return;
      if (node.nodeType !== 1) return;
      if (seen.has(node)) return;
      seen.add(node);
      nodes.push(node);
    };
    const ensureNodes = (selector) => {
      if (!selector || typeof selector !== "string") return;
      try {
        document.querySelectorAll(selector).forEach((node) => pushNode(node));
      } catch (err) {}
    };
    for (const selector of rootSelectors) {
      ensureNodes(selector);
    }
    if (nodes.length === 0) {
      ensureNodes("[data-message-id]");
      ensureNodes("[data-message-ts]");
      ensureNodes(".c-message_kit__message");
      ensureNodes(".p-message_pane_message");
      ensureNodes(".c-virtual_list__item");
      ensureNodes("[data-qa='virtual-list-item']");
    }
    const attr = (element, name) => {
      if (!element || typeof element.getAttribute !== "function") return "";
      const value = element.getAttribute(name);
      return typeof value === "string" ? value : "";
    };
    const registerValue = (set, value) => {
      if (typeof value === "string" && value.length > 0) set.add(value);
    };
    const collectTs = (element) => {
      const values = new Set();
      const queue = [];
      const visited = new Set();
      if (element) queue.push(element);
      while (queue.length > 0) {
        const current = queue.shift();
        if (!current || typeof current !== "object") continue;
        if (visited.has(current)) continue;
        visited.add(current);
        if (current.nodeType !== 1) continue;
        registerValue(values, attr(current, "data-message-ts"));
        registerValue(values, attr(current, "data-message-id"));
        registerValue(values, attr(current, "data-message-ts-normalized"));
        registerValue(values, attr(current, "data-ts"));
        registerValue(values, attr(current, "data-qa-ts"));
        registerValue(values, attr(current, "data-qa-message-id"));
        registerValue(values, attr(current, "data-sort-key"));
        if (current.dataset) {
          for (const key of Object.keys(current.dataset)) {
            const value = current.dataset[key];
            if (typeof value === "string" && value) registerValue(values, value);
          }
        }
        if (current.matches && current.matches("time[datetime]")) {
          registerValue(values, attr(current, "datetime"));
        }
        if (typeof current.querySelectorAll === "function") {
          current
            .querySelectorAll("[data-message-ts],[data-message-id],[data-ts],[data-qa-ts],time[datetime]")
            .forEach((child) => queue.push(child));
        }
      }
      return Array.from(values);
    };
    const matchesNeedle = (value) =>
      typeof value === "string" && needles.some((needle) => value.includes(needle));
    const cleanupSelectors = [
      "[data-qa='message_reactions']",
      "[data-qa='message-reactions']",
      "[data-qa='message_actions']",
      "[data-qa='add-reaction']",
      "[data-qa='more_message_actions']",
      ".c-reaction",
      ".c-reaction_bar",
      ".c-message_kit__reaction",
      ".c-message_kit__reaction_bar",
      ".c-message_kit__actions",
      ".p-message_pane_message__actions",
    ];
    const sanitizeNode = (node) => {
      if (!node || typeof node.cloneNode !== "function") return node;
      const clone = node.cloneNode(true);
      for (const selector of cleanupSelectors) {
        try {
          clone.querySelectorAll(selector).forEach((element) => element.remove());
        } catch (err) {}
      }
      return clone;
    };
    const describeNode = (node, index) => {
      if (!node || typeof node !== "object") return null;
      const tag = typeof node.tagName === "string" ? node.tagName.toLowerCase() : null;
      const classes =
        typeof node.className === "string" && node.className.length > 0
          ? node.className.split(/\\s+/).filter(Boolean).slice(0, 10)
          : [];
      const attrs = {};
      if (node.attributes && typeof node.attributes === "object") {
        const list = Array.from(node.attributes).slice(0, 10);
        for (const attr of list) {
          if (attr && typeof attr.name === "string") {
            attrs[attr.name] = String(attr.value ?? "").slice(0, 160);
          }
        }
      }
      const dataset = {};
      if (node.dataset && typeof node.dataset === "object") {
        const keys = Object.keys(node.dataset).slice(0, 10);
        for (const key of keys) {
          dataset[key] = String(node.dataset[key] ?? "").slice(0, 160);
        }
      }
      let datetime = null;
      if (typeof node.querySelector === "function") {
        const timeNode = node.querySelector("time[datetime]");
        if (timeNode && typeof timeNode.getAttribute === "function") {
          datetime = timeNode.getAttribute("datetime");
        }
      }
      const text =
        typeof node.innerText === "string"
          ? node.innerText.trim().slice(0, 120)
          : typeof node.textContent === "string"
            ? node.textContent.trim().slice(0, 120)
            : null;
      return {
        index,
        tag,
        classes,
        attrs,
        dataset,
        datetime,
        text,
      };
    };
    const collectSampleTs = () => {
      if (!debugMode) return undefined;
      const sample = [];
      for (const node of nodes) {
        for (const value of collectTs(node)) {
          if (!sample.includes(value)) sample.push(value);
          if (sample.length >= 12) break;
        }
        if (sample.length >= 12) break;
      }
      return sample;
    };
    const collectSamples = () => {
      if (!debugMode) return undefined;
      const result = [];
      const limit = Math.min(nodes.length, 5);
      for (let i = 0; i < limit; i += 1) {
        const node = nodes[i];
        const described = describeNode(node, i);
        if (described) result.push(described);
      }
      return result;
    };
    const findTarget = () => {
      for (const node of nodes) {
        const values = collectTs(node);
        if (values.some(matchesNeedle)) return node;
      }
      return null;
    };
    let target = findTarget();
    if (!target) {
      ensureNodes("[data-message-id]");
      ensureNodes("[data-message-ts]");
      ensureNodes("[data-qa='message']");
      ensureNodes("[data-qa='message_container']");
      ensureNodes(".c-message_kit__message");
      ensureNodes(".p-message_pane_message");
      target = findTarget();
    }
    if (!target) {
      return {
        status: "no-target",
        needles,
        candidateCount: nodes.length,
        sampleTs: collectSampleTs(),
        samples: collectSamples(),
      };
    }
    let body = null;
    for (const selector of bodySelectors) {
      try {
        const found = target.querySelector(selector);
        if (found) {
          body = found;
          if (found.innerText && found.innerText.trim().length > 0) break;
        }
      } catch (err) {}
    }
    const source = body || target;
    const sanitized = sanitizeNode(source);
    const rawText = sanitized?.innerText || sanitized?.textContent || "";
    const text = typeof rawText === "string" ? rawText.trim() : "";
    if (!text) {
      return {
        status: "empty-text",
        needles,
        hasBody: Boolean(body),
        matchedTs: collectTs(target),
        samples: collectSamples(),
      };
    }
    let channelName = null;
    let channelId = null;
    const headerNode = (body || target)?.closest(
      "[data-qa='message_container'], .p-message_pane_message, .p-threads_view__thread_message"
    );
    if (headerNode) {
      channelId = attr(headerNode, "data-qa-channel-id") || attr(headerNode, "data-qa-conversation-id");
    }
    for (const selector of channelSelectors) {
      try {
        const found = document.querySelector(selector);
        if (found && typeof found.textContent === "string") {
          const value = found.textContent.trim();
          if (value) {
            channelName = value;
            break;
          }
        }
      } catch (err) {}
    }
    if (!channelName) {
      try {
        const inline = document.querySelector(
          "[data-qa='inline_channel_entity'][data-channel-id] [data-qa='inline_channel_entity__name']"
        );
        if (inline && typeof inline.textContent === "string") {
          channelName = inline.textContent.trim();
          const owner = inline.closest("[data-qa='inline_channel_entity']");
          if (owner && typeof owner.getAttribute === "function") {
            const inlineId = owner.getAttribute("data-channel-id");
            if (inlineId) {
              channelId = inlineId;
            }
          }
        }
      } catch (err) {}
    }
    return {
      text,
      channel: channelName,
      channelId,
      matchedTs: collectTs(target),
    };
  } catch (err) {
    return {
      error: typeof err === "object" && err && err.message ? err.message : String(err),
    };
  }
})`;

type ExecutionContextDescription = {
  id: number;
  name: string;
  origin?: string;
  auxData?: {
    frameId?: string;
    type?: string;
    isDefault?: boolean;
  };
};

type RuntimeExecutionContextCreatedEvent = {
  context: ExecutionContextDescription;
};

type RuntimeExecutionContextDestroyedEvent = {
  executionContextId: number;
};

type FrameContextInfo = {
  default?: number;
  isolated?: number;
  other: number[];
};

type ReactionDomCandidate = {
  channelId?: string | null;
  ts: string;
  normalizedTs: string;
};

type DomSample = {
  index: number;
  tag: string | null;
  classes: string[];
  attrs: Record<string, string>;
  dataset: Record<string, string>;
  datetime: string | null;
  text: string | null;
};

type DomEvaluationSuccess = {
  ok: true;
  text: string;
  channelName?: string | null;
  channelId?: string | null;
  matchedTs?: string[];
};

type DomEvaluationFailureReason = "no-target" | "empty-text";

type DomEvaluationFailure = {
  ok: false;
  reason: DomEvaluationFailureReason;
  detail: {
    needles: string[];
    candidateCount?: number;
    sampleTs?: string[];
    samples?: DomSample[];
    hasBody?: boolean;
  };
};

type DomEvaluationOutcome = DomEvaluationSuccess | DomEvaluationFailure;

export class SlackAdapter implements IngestionAdapter {
  name = "slack";
  private readonly now: () => Date;
  private readonly timezone: string;
  private emit: EmitFn | null = null;
  private readonly cache: Map<string, { text?: string; user?: string }> = new Map();
  private readonly seenUids: Set<string> = new Set();
  private readonly domCaptureTasks: Map<string, Promise<void>> = new Map();
  private readonly domCaptureByTs: Map<
    string,
    { text: string; channelName?: string | null; channelId?: string | null; capturedAt: number }
  > = new Map();
  private readonly channelNames: Map<string, string> = new Map();
  private readonly debugEnabled =
    DEBUG_TARGETS.has("slack") || DEBUG_TARGETS.has("slack:verbose") || DOM_PROBE_DEBUG_ENABLED;
  private readonly debugVerboseEnabled = DEBUG_TARGETS.has("slack:verbose");
  private readonly domProbeEnabled = DOM_PROBE_DEBUG_ENABLED;
  private readonly domDebugDetailed = DOM_VERBOSE_ENABLED;
  private readonly domCaptureDisabled = DOM_CAPTURE_DISABLED;
  private readonly debugNetworkEvents = DEBUG_NETWORK_ENABLED;
  private readonly debugFetchEvents = DEBUG_FETCH_ENABLED;
  private readonly debugRuntimeEvents = DEBUG_RUNTIME_ENABLED;
  private readonly contextsByFrame: Map<string, FrameContextInfo> = new Map();
  private readonly frameIdByContext: Map<number, string | null> = new Map();
  private defaultContextId: number | null = null;

  constructor(private readonly deps: SlackAdapterDeps) {
    this.now = deps.now ?? (() => new Date());
    this.timezone = deps.timezone ?? "Asia/Tokyo";
  }

  async start(emit: EmitFn): Promise<void> {
    this.emit = emit;
    const { Network, Fetch, Runtime } = this.deps.client;

    await Network.enable({});
    await Network.setCacheDisabled({ cacheDisabled: true });
    this.debugVerbose("Network domain enabled");
    Network.on("webSocketFrameReceived", (payload) => {
      if (this.debugNetworkEvents) {
        this.debug("webSocketFrameReceived", this.safePreview(payload));
      }
      this.handleWebSocketFrame(payload as WebSocketFrameEvent);
    });
    Network.on("webSocketFrameSent", (payload) => {
      if (this.debugNetworkEvents) {
        this.debug("webSocketFrameSent", this.safePreview(payload));
      }
      this.handleWebSocketFrame(payload as WebSocketFrameEvent);
    });
    Network.on("responseReceived", (payload) => {
      if (this.debugNetworkEvents) {
        this.debug("responseReceived", this.safePreview(payload));
      }
      void this.handleResponseReceived(payload as ResponseReceivedEvent);
    });

    if (typeof Runtime.on === "function") {
      Runtime.on("executionContextCreated", (payload) => {
        if (this.debugRuntimeEvents) {
          this.debug("executionContextCreated", this.safePreview(payload));
        }
        this.handleExecutionContextCreated(payload as RuntimeExecutionContextCreatedEvent);
      });
      Runtime.on("executionContextDestroyed", (payload) => {
        if (this.debugRuntimeEvents) {
          this.debug("executionContextDestroyed", this.safePreview(payload));
        }
        this.handleExecutionContextDestroyed(payload as RuntimeExecutionContextDestroyedEvent);
      });
    }
    if (typeof Runtime.enable === "function") {
      await Runtime.enable({});
      this.debugVerbose("Runtime domain enabled");
    }
    if (this.domProbeEnabled) {
      void this.runDomProbe().catch((err) => {
        this.debug("dom probe failed", this.safePreview(err));
      });
    }

    await Fetch.enable({
      patterns: [
        { urlPattern: "*://*.slack.com/api/chat.postMessage*", requestStage: "Request" },
        { urlPattern: "*://*.slack.com/api/reactions.*", requestStage: "Request" },
      ],
    });
    this.debugVerbose("Fetch domain enabled with patterns");

    Fetch.on("requestPaused", async (event: FetchPausedEvent) => {
      if (this.debugFetchEvents) {
        this.debug("requestPaused", this.safePreview(event));
      }
      try {
        const normalizedEvents = await this.handleRequest(event);
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

  private async handleRequest(event: FetchPausedEvent): Promise<NormalizedEvent[]> {
    if (event.request.method !== "POST") return [];
    if (!SLACK_API_RE.test(event.request.url)) return [];

    const body = event.request.postData ?? "";
    const contentType = this.normalizeHeader(event.request.headers, "content-type");
    const normalizeOpts: NormalizeOptions = { now: this.now(), timezone: this.timezone };
    const url = new URL(event.request.url);
    const payload = this.parseBody(body, contentType);
    if (!payload) {
      this.debug("parseBody returned null", { url: event.request.url, contentType });
      return [];
    }

    this.debugVerbose("parsed payload", this.redactPayload(payload));

    if (url.pathname.endsWith("/api/chat.postMessage")) {
      const channelId = typeof payload.channel === "string" ? payload.channel : "";
      const userId = typeof payload.user === "string" ? payload.user : undefined;
      const blocks = payload.blocks as Parameters<typeof fromBlocks>[0];
      const rawTs = this.asString(payload.ts);
      const slackTs = this.resolveMessageTs(rawTs ?? this.asString(payload.thread_ts));

      let domCaptured: {
        text?: string;
        channelName?: string | null;
        channelId?: string | null;
      } | null = null;
      if (channelId) {
        await this.captureDomCandidate({
          channelId,
          ts: slackTs,
          normalizedTs: this.normalizedTimestamp(slackTs) ?? slackTs,
        });
        domCaptured = this.consumeDomCapture(slackTs);
        if (domCaptured?.channelId && domCaptured.channelName) {
          this.cacheChannelName(domCaptured.channelId, domCaptured.channelName);
        }
      }

      const channelNameHint =
        domCaptured?.channelName ?? this.resolveChannelName(channelId) ?? channelId;

      const event = normalizeSlackMessage(
        {
          channel: { id: channelId, name: channelNameHint },
          user: { id: userId ?? "unknown", name: userId },
          ts: slackTs,
          text: payload.text as string | undefined,
          blocks,
          thread_ts: payload.thread_ts as string | undefined,
          raw_ts: rawTs,
        },
        normalizeOpts
      );

      if (channelId && channelNameHint) {
        this.cacheChannelName(channelId, channelNameHint);
      }

      if (channelId) {
        const textFromDom = domCaptured?.text ?? undefined;
        const fallbackText = (payload.text as string | undefined) ?? fromBlocks(blocks);
        const resolvedText = textFromDom ?? fallbackText;
        this.cacheMessage(channelId, slackTs, {
          text: resolvedText,
          user: userId,
        });
        if (rawTs && rawTs !== slackTs) {
          this.cacheMessage(channelId, rawTs, {
            text: resolvedText,
            user: userId,
          });
        }
      }

      return [event];
    }

    if (url.pathname.startsWith("/api/reactions.")) {
      const item = payload.item as Record<string, unknown> | undefined;
      const channelId = this.asString(payload.channel) ?? this.asString(item?.channel) ?? "";
      const rawItemTs = this.asString(payload.timestamp) ?? this.asString(item?.ts);
      const normalizedItemTs = this.normalizedTimestamp(rawItemTs);
      const fallbackItemTs = this.resolveMessageTs(undefined);
      const action = url.pathname.endsWith(".add")
        ? "added"
        : url.pathname.endsWith(".remove")
          ? "removed"
          : "added";
      const userId = this.asString(payload.user) ?? "unknown";
      const reactionName = this.asString(payload.name) ?? this.asString(payload.reaction);
      const eventTs = this.asString(payload.event_ts);
      const itemTsForEvent = rawItemTs ?? normalizedItemTs ?? fallbackItemTs;
      if (!channelId || !itemTsForEvent || !reactionName) {
        this.debug("reaction payload missing fields", {
          channelId,
          itemTs: itemTsForEvent,
          reactionName,
          payload: this.redactPayload(payload),
        });
        return [];
      }

      const candidate = this.buildReactionDomCandidate({
        ...(payload as Record<string, unknown>),
        channel: channelId,
        channel_id: channelId,
        reaction: reactionName,
        timestamp: rawItemTs,
        item,
      });
      if (candidate) {
        await this.captureDomCandidate(candidate);
      }

      const domCaptured = this.consumeDomCapture(itemTsForEvent);
      if (domCaptured?.text) {
        this.cacheMessage(channelId, itemTsForEvent, { text: domCaptured.text });
      }
      const domChannelId = domCaptured?.channelId ?? channelId;
      if (domChannelId && domCaptured?.channelName) {
        this.cacheChannelName(domChannelId, domCaptured.channelName);
      }

      const lookupKeys = [rawItemTs, normalizedItemTs, fallbackItemTs]
        .filter((value): value is string => Boolean(value))
        .map((value) => this.cacheKey(channelId, value));
      const cached = lookupKeys
        .map((key) => this.cache.get(key))
        .find((entry): entry is { text?: string; user?: string } => Boolean(entry));
      const messageText =
        domCaptured?.text ?? cached?.text ?? this.asString(payload.message_text) ?? undefined;
      const messageUser = cached?.user ?? this.asString(payload.message_user) ?? undefined;
      const resolvedChannelName =
        this.resolveChannelName(domChannelId) ?? domCaptured?.channelName ?? channelId;
      if (domChannelId && resolvedChannelName) {
        this.cacheChannelName(domChannelId, resolvedChannelName);
      }
      const userIdForEvent = cached?.user ?? userId;

      const reactionEvent = normalizeSlackReaction(
        {
          channel: { id: channelId, name: resolvedChannelName },
          user: {
            id: userIdForEvent,
            name: messageUser ?? userIdForEvent,
          },
          item_ts: itemTsForEvent,
          action,
          reaction: reactionName,
          event_ts: eventTs,
          message_text: messageText,
        },
        normalizeOpts
      );
      return [reactionEvent];
    }

    return [];
  }

  private normalizeHeader(headers: Record<string, string> | undefined, key: string): string {
    if (!headers) return "";
    const direct = headers[key];
    if (direct) return direct;
    const lower = headers[key.toLowerCase()];
    if (lower) return lower;
    const upper = headers[key.toUpperCase()];
    if (upper) return upper;
    const target = key.toLowerCase();
    for (const [k, value] of Object.entries(headers)) {
      if (k.toLowerCase() === target) return value;
    }
    return "";
  }

  private handleWebSocketFrame(event: WebSocketFrameEvent): void {
    const payload = event.response.payloadData;
    if (!payload || payload.length > 512 * 1024) return;
    try {
      const data = JSON.parse(payload);
      if (data?.type === "message" && data.channel && data.ts) {
        const text = fromBlocks(data.blocks);
        this.cacheMessage(data.channel, data.ts, { text, user: data.user });
      } else if (data?.type === "message_changed" && data.channel && data.message?.ts) {
        const msg = data.message;
        const text = fromBlocks(msg.blocks);
        this.cacheMessage(data.channel, msg.ts, { text, user: msg.user });
      } else if (data?.type === "thread_broadcast" && data.channel && data.root_ts) {
        const text = fromBlocks(data.blocks);
        this.cacheMessage(data.channel, data.root_ts, { text, user: data.user });
      }
    } catch {
      /* ignore JSON parse errors */
    }
  }

  private buildReactionDomCandidate(value: Record<string, unknown>): ReactionDomCandidate | null {
    const type = this.asString(value.type);
    const subtype = this.asString(value.subtype);
    const reactionName = this.asString(value.reaction) ?? this.asString(value.name);
    const indicatesReaction =
      (type && REACTION_PAYLOAD_KEYS.includes(type)) ||
      (subtype && REACTION_PAYLOAD_KEYS.includes(subtype)) ||
      Boolean(reactionName);
    if (!indicatesReaction) return null;

    const item = value.item as Record<string, unknown> | undefined;
    const tsCandidate =
      this.asString(item?.message_ts) ??
      this.asString(item?.ts) ??
      this.asString(value.message_ts) ??
      this.asString(value.event_ts) ??
      this.asString(value.timestamp) ??
      this.asString(value.ts);
    if (!tsCandidate) return null;

    const channelCandidate =
      this.asString(value.channel) ??
      this.asString(value.channel_id) ??
      this.asString(item?.channel) ??
      this.asString(item?.channel_id);

    const normalizedTs = this.normalizedTimestamp(tsCandidate) ?? tsCandidate;
    return {
      channelId: channelCandidate ?? null,
      ts: tsCandidate,
      normalizedTs,
    };
  }

  private scheduleDomCapture(candidate: ReactionDomCandidate): void {
    void this.captureDomCandidate(candidate);
  }

  private async captureDomCandidate(candidate: ReactionDomCandidate): Promise<void> {
    if (this.domCaptureDisabled) return;
    const key = candidate.normalizedTs;
    if (!key) return;
    const existing = this.domCaptureTasks.get(key);
    if (existing) {
      await existing.catch(() => {
        /* upstreamでログ済み */
      });
      return;
    }
    const task = this.runDomCapture(candidate).catch((err) => {
      this.debug("dom capture failed", this.safePreview(err));
    });
    this.domCaptureTasks.set(key, task);
    try {
      await task;
    } finally {
      this.domCaptureTasks.delete(key);
    }
  }

  private async runDomCapture(candidate: ReactionDomCandidate): Promise<void> {
    const { ts, normalizedTs, channelId } = candidate;
    const variantSet = new Set<string>();
    if (ts) variantSet.add(ts);
    if (normalizedTs) variantSet.add(normalizedTs);
    const normalizedFromTs = this.normalizedTimestamp(ts);
    if (normalizedFromTs) variantSet.add(normalizedFromTs);
    const tsVariants = Array.from(variantSet).filter((value) => value.length > 0);
    if (tsVariants.length === 0) return;
    let lastFailure: DomEvaluationFailure | null = null;
    for (const delay of DOM_RETRY_DELAYS_MS) {
      if (delay > 0) await this.sleep(delay);
      const outcome = await this.evaluateDomForMessage(tsVariants, this.domDebugDetailed);
      if (!outcome) continue;
      if (!outcome.ok) {
        lastFailure = outcome;
        continue;
      }
      const text = this.asString(outcome.text);
      if (!text) continue;
      this.storeDomCapture(
        candidate,
        {
          text,
          channelName: outcome.channelName ?? channelId,
          channelId: outcome.channelId ?? channelId,
          matchedTs: outcome.matchedTs,
        },
        tsVariants
      );
      const channelKey = outcome.channelId ?? channelId ?? null;
      const channelLabel =
        outcome.channelName ?? (channelKey ? (this.resolveChannelName(channelKey) ?? null) : null);
      if (channelKey && channelLabel) {
        this.cacheChannelName(channelKey, channelLabel);
      }
      if (channelKey) {
        this.cacheMessage(channelKey, normalizedTs, { text });
      }
      const excerpt = this.toExcerpt(text);
      console.log(
        JSON.stringify({
          ok: true,
          ts: normalizedTs,
          channel: channelLabel ?? channelKey,
          excerpt,
        })
      );
      return;
    }
    if (this.domDebugDetailed && lastFailure) {
      this.logDomFailure(normalizedTs, lastFailure);
    }
    console.log(
      JSON.stringify({
        ok: false,
        ts: normalizedTs,
        channel: channelId ?? null,
        reason: "dom-not-found",
      })
    );
  }

  private async evaluateDomForMessage(
    tsList: string[],
    collectDebug: boolean
  ): Promise<DomEvaluationOutcome | null> {
    const needles = tsList.filter((value) => typeof value === "string" && value.length > 0);
    if (needles.length === 0) return null;
    const selectors = {
      root: DOM_ROOT_SELECTORS,
      body: DOM_BODY_SELECTORS,
      channel: DOM_CHANNEL_NAME_SELECTORS,
    };
    const expression = `${DOM_CAPTURE_SCRIPT}(${JSON.stringify(needles)}, ${JSON.stringify(selectors)}, ${
      collectDebug ? "true" : "false"
    })`;
    let lastFailure: DomEvaluationFailure | null = null;
    for (const contextId of this.resolveContextIds()) {
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
        if (!value || typeof value !== "object") continue;
        const record = value as Record<string, unknown>;
        if ("error" in record && record.error) {
          continue;
        }
        if ("status" in record && typeof record.status === "string") {
          const reason = record.status as DomEvaluationFailureReason;
          const failure: DomEvaluationFailure = {
            ok: false,
            reason,
            detail: {
              needles,
              candidateCount: Number.isFinite(record.candidateCount as number)
                ? (record.candidateCount as number)
                : undefined,
              sampleTs: Array.isArray(record.sampleTs)
                ? (record.sampleTs as unknown[]).filter(
                    (entry): entry is string => typeof entry === "string" && entry.length > 0
                  )
                : undefined,
              samples:
                collectDebug && Array.isArray(record.samples)
                  ? (record.samples as DomSample[])
                  : undefined,
              hasBody:
                typeof record.hasBody === "boolean" ? (record.hasBody as boolean) : undefined,
            },
          };
          lastFailure = failure;
          continue;
        }
        const text = this.asString(record.text);
        if (!text) continue;
        const channelName = this.asString(record.channel);
        const matchedTs = Array.isArray(record.matchedTs)
          ? (record.matchedTs as unknown[]).filter(
              (entry): entry is string => typeof entry === "string" && entry.length > 0
            )
          : undefined;
        return {
          ok: true,
          text,
          channelName: channelName ?? null,
          matchedTs,
        };
      } catch {
        /* ignore context evaluation errors */
      }
    }
    return lastFailure;
  }

  private toExcerpt(text: string): string {
    if (text.length <= DOM_EXCERPT_LENGTH) return text;
    return `${text.slice(0, DOM_EXCERPT_LENGTH)}...`;
  }

  private storeDomCapture(
    candidate: ReactionDomCandidate,
    data: {
      text: string;
      channelName?: string | null;
      channelId?: string | null;
      matchedTs?: string[];
    },
    variants: string[]
  ): void {
    const entry = {
      text: data.text,
      channelName: data.channelName ?? null,
      channelId: data.channelId ?? null,
      capturedAt: Date.now(),
    };
    const keys = new Set<string>();
    keys.add(candidate.normalizedTs);
    keys.add(candidate.ts);
    for (const variant of variants) {
      if (variant) keys.add(variant);
    }
    if (Array.isArray(data.matchedTs)) {
      for (const value of data.matchedTs) {
        if (typeof value === "string" && value.length > 0) keys.add(value);
      }
    }
    for (const key of keys) {
      if (key) this.domCaptureByTs.set(key, entry);
    }
    this.pruneDomCache();
  }

  private consumeDomCapture(
    ts: string | undefined
  ): { text?: string; channelName?: string | null; channelId?: string | null } | null {
    if (!ts) return null;
    const normalized = this.normalizedTimestamp(ts);
    const keys = new Set<string>();
    keys.add(ts);
    if (normalized) keys.add(normalized);
    let entry: {
      text: string;
      channelName?: string | null;
      channelId?: string | null;
      capturedAt: number;
    } | null = null;
    for (const key of keys) {
      const stored = this.domCaptureByTs.get(key);
      if (stored) entry = stored;
    }
    if (!entry) return null;
    for (const key of keys) {
      this.domCaptureByTs.delete(key);
    }
    return {
      text: entry.text,
      channelName: entry.channelName ?? undefined,
      channelId: entry.channelId ?? undefined,
    };
  }

  private pruneDomCache(): void {
    if (this.domCaptureByTs.size <= DOM_CACHE_MAX_ENTRIES) return;
    const entries = Array.from(this.domCaptureByTs.entries()).sort(
      (a, b) => a[1].capturedAt - b[1].capturedAt
    );
    while (this.domCaptureByTs.size > DOM_CACHE_MAX_ENTRIES && entries.length > 0) {
      const [key] = entries.shift() ?? [];
      if (key) {
        this.domCaptureByTs.delete(key);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  private logDomFailure(ts: string, failure: DomEvaluationFailure): void {
    const payload: Record<string, unknown> = {
      ts,
      reason: failure.reason,
      needles: failure.detail.needles,
      candidateCount: failure.detail.candidateCount,
      sampleTs: failure.detail.sampleTs,
      hasBody: failure.detail.hasBody,
    };
    if (failure.detail.samples) {
      payload.samples = failure.detail.samples;
    }
    this.debug("dom capture failure", payload);
  }

  private async handleResponseReceived(event: ResponseReceivedEvent): Promise<void> {
    if (!SLACK_API_RE.test(event.response.url)) return;
    try {
      const { body, base64Encoded } = await this.deps.client.Network.getResponseBody({
        requestId: event.requestId,
      });
      const txt = base64Encoded ? Buffer.from(body, "base64").toString("utf8") : body;
      const data = JSON.parse(txt);
      const message = data?.message ?? data?.item;
      if (message?.channel && message?.ts) {
        const text = fromBlocks(message.blocks);
        this.cacheMessage(message.channel, message.ts, { text, user: message.user });
      }
    } catch {
      /* ignore errors */
    }
  }

  private cacheMessage(
    channel: string,
    ts: string,
    value: { text?: string | null; user?: string | null }
  ): void {
    if (!channel || !ts) return;
    this.cache.set(this.cacheKey(channel, ts), {
      text: value.text ?? undefined,
      user: value.user ?? undefined,
    });
  }

  private cacheChannelName(channelId: string, label?: string | null): void {
    const normalizedId = channelId?.trim();
    const normalizedLabel = label?.trim();
    if (!normalizedId || !normalizedLabel) {
      return;
    }
    if (normalizedLabel === normalizedId) {
      return;
    }
    this.channelNames.set(normalizedId, normalizedLabel);
  }

  private resolveChannelName(channelId: string | null | undefined): string | undefined {
    const normalizedId = channelId?.trim();
    if (!normalizedId) {
      return undefined;
    }
    return this.channelNames.get(normalizedId);
  }

  private cacheKey(channel: string, ts: string): string {
    return `${channel}@${ts}`;
  }

  private resolveMessageTs(ts: string | undefined): string {
    const normalized = this.normalizedTimestamp(ts);
    if (normalized) return normalized;
    const now = this.now();
    const epochSeconds = Math.floor(now.getTime() / 1000);
    const millis = now.getMilliseconds();
    return `${epochSeconds}.${String(millis).padStart(3, "0")}000`;
  }

  private async deliver(event: NormalizedEvent, emit: EmitFn): Promise<void> {
    if (!event || !event.uid) return;
    if (this.seenUids.has(event.uid)) return;
    this.seenUids.add(event.uid);
    this.debugVerbose("deliver", event);
    await emit(event);
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
      const context = event?.context;
      if (!context || typeof context.id !== "number") return;
      if (this.debugRuntimeEvents) {
        this.debug("executionContextCreated", this.safePreview(event));
      }
      const frameId = context.auxData?.frameId ?? null;
      const type = context.auxData?.type;
      const isDefault = Boolean(context.auxData?.isDefault || type === "default");
      if (frameId) {
        const info: FrameContextInfo = this.contextsByFrame.get(frameId) ?? { other: [] };
        if (isDefault) {
          info.default = context.id;
          this.defaultContextId = context.id;
        } else if (type === "isolated") {
          info.isolated = context.id;
        } else {
          if (!info.other.includes(context.id)) info.other.push(context.id);
        }
        this.contextsByFrame.set(frameId, info);
      } else if (isDefault) {
        this.defaultContextId = context.id;
      }
      this.frameIdByContext.set(context.id, frameId);
    } catch (err) {
      this.debugVerbose("executionContextCreated error", err);
    }
  }

  private handleExecutionContextDestroyed(event: RuntimeExecutionContextDestroyedEvent): void {
    try {
      const contextId = event?.executionContextId;
      if (typeof contextId !== "number") return;
      if (this.debugRuntimeEvents) {
        this.debug("executionContextDestroyed", this.safePreview(event));
      }
      const frameId = this.frameIdByContext.get(contextId);
      if (frameId) {
        const info = this.contextsByFrame.get(frameId);
        if (info) {
          if (info.default === contextId) delete info.default;
          if (info.isolated === contextId) delete info.isolated;
          info.other = info.other.filter((id) => id !== contextId);
          if (!info.default && !info.isolated && info.other.length === 0) {
            this.contextsByFrame.delete(frameId);
          } else {
            this.contextsByFrame.set(frameId, info);
          }
        }
      }
      this.frameIdByContext.delete(contextId);
      if (this.defaultContextId === contextId) {
        this.defaultContextId = null;
      }
    } catch (err) {
      this.debugVerbose("executionContextDestroyed error", err);
    }
  }

  private resolveContextIds(frameId?: string): Array<number | null> {
    const result: Array<number | null> = [];
    if (frameId) {
      const info = this.contextsByFrame.get(frameId);
      if (info) {
        if (typeof info.default === "number") result.push(info.default);
        if (typeof info.isolated === "number") {
          if (!result.includes(info.isolated)) result.push(info.isolated);
        }
        for (const id of info.other) {
          if (!result.includes(id)) result.push(id);
        }
      }
    }
    if (this.defaultContextId !== null && !result.includes(this.defaultContextId)) {
      result.push(this.defaultContextId);
    }
    result.push(null);
    return result;
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
        window.__REACLOG_DOM_PROBE__ = { timestamp, ready };
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
    for (const contextId of this.resolveContextIds()) {
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
        this.debug("dom probe result", { contextId, value: this.safePreview(value) });
        if (value && typeof value === "object" && (value as { ok?: boolean }).ok) {
          return;
        }
      } catch (err) {
        this.debug("dom probe context error", { contextId, error: this.safePreview(err) });
      }
    }
  }

  private redactPayload(payload: Record<string, unknown>): Record<string, unknown> {
    const cloned: Record<string, unknown> = { ...payload };
    for (const key of Object.keys(cloned)) {
      if (typeof cloned[key] === "string" && /(token|cookie)/i.test(key)) {
        cloned[key] = "[redacted]";
      }
    }
    return cloned;
  }

  private parseBody(body: string, contentType: string): Record<string, unknown> | null {
    if (!body) return {};
    if (/application\/json|text\/json/i.test(contentType) || body.trim().startsWith("{")) {
      try {
        return JSON.parse(body);
      } catch {
        this.debug("failed to parse JSON body");
        return null;
      }
    }

    if (/application\/x-www-form-urlencoded/i.test(contentType)) {
      try {
        const params = new URLSearchParams(body);
        const result: Record<string, unknown> = {};
        for (const [key, value] of params.entries()) {
          result[key] = value;
          if (key === "payload") {
            try {
              const parsed = JSON.parse(value);
              Object.assign(result, parsed);
            } catch {
              this.debug("failed to parse nested payload JSON");
            }
          }
        }
        return result;
      } catch {
        this.debug("failed to parse form body");
        return null;
      }
    }

    if (/multipart\/form-data/i.test(contentType)) {
      const boundaryMatch = contentType.match(/boundary=([^;]+)/i);
      if (!boundaryMatch) {
        this.debug("missing multipart boundary");
        return null;
      }

      const boundary = `--${boundaryMatch[1].replace(/^["']|["']$/g, "")}`;
      const segments = body.split(boundary);
      const result: Record<string, unknown> = {};

      for (const segment of segments) {
        const trimmed = segment.trim();
        if (!trimmed || trimmed === "--") continue;

        const [headerSection, ...valueSections] = trimmed.split("\r\n\r\n");
        if (!headerSection || valueSections.length === 0) continue;

        const headers = headerSection.split("\r\n");
        const disposition = headers.find((line) => /content-disposition/i.test(line)) ?? "";
        const nameMatch = disposition.match(/name="([^"]+)"/i);
        if (!nameMatch) continue;

        let value = valueSections.join("\r\n\r\n");
        value = value.replace(/\r\n--$/, "");
        const normalizedValue = value.trim();

        result[nameMatch[1]] = normalizedValue;
        if (nameMatch[1] === "payload") {
          try {
            const parsed = JSON.parse(normalizedValue);
            Object.assign(result, parsed);
          } catch {
            this.debug("failed to parse multipart payload JSON");
          }
        }
      }

      return result;
    }

    return null;
  }

  private debug(message: string, payload?: unknown): void {
    if (!this.debugEnabled) return;
    if (payload === undefined) {
      console.log(`[SlackAdapter] ${message}`);
      return;
    }
    console.log(`[SlackAdapter] ${message}:`, payload);
  }

  private debugVerbose(message: string, payload?: unknown): void {
    if (!this.debugVerboseEnabled) return;
    this.debug(message, payload);
  }

  private safePreview(payload: unknown): unknown {
    if (!payload) return payload;
    try {
      return JSON.parse(
        JSON.stringify(payload, (_, value) =>
          typeof value === "bigint" ? value.toString() : value
        )
      );
    } catch {
      return payload;
    }
  }
}
