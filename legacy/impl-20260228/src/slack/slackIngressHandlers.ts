import type { NormalizedEvent } from "../core/events.js";
import { fromBlocks } from "./blocks.js";
import { normalizeSlackMessage, normalizeSlackReaction } from "./normalize.js";
import type { ReactionDomCandidate } from "./domCaptureService.js";
import type { SlackNameCacheRepository } from "./nameCacheRepository.js";
import type { ResponseBodyReader } from "./responseBodyReader.js";
import type { SlackResponseProjector } from "./responseProjector.js";
import type { SlackDebug } from "./slackDebug.js";
import { SlackIngressRequestParser } from "./slackIngressRequestParser.js";
import { SlackResponseCacheUpdater } from "./slackResponseCacheUpdater.js";
import { SlackWsNormalizer } from "./slackWsNormalizer.js";

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
  type?: string;
  response: {
    url: string;
    status?: number;
    statusText?: string;
    mimeType?: string;
    headers?: Record<string, string>;
  };
};

export type RequestWillBeSentEvent = {
  requestId: string;
  type?: string;
  initiator?: {
    type?: string;
  };
  request: {
    url: string;
    method: string;
    headers?: Record<string, string>;
    postData?: string;
  };
};

type CacheEntry = { text?: string; user?: string; teamId?: string };

type SlackIngressHandlersDeps = {
  now: () => Date;
  timezone: string;
  slackApiRe: RegExp;
  debugFetchHookEnabled: boolean;
  debugNotificationEnabled: boolean;
  slackDebug: SlackDebug;
  pushDebugEvent: (kind: "raw_fetch" | "raw_ws" | "normalized", payload: unknown) => void;
  truncateForDebug: (value: string, max: number) => string;
  domCapture: {
    capture: (candidate: ReactionDomCandidate) => Promise<void>;
    consume: (
      ts: string | undefined
    ) => { text?: string; channelName?: string | null; channelId?: string | null } | null;
  };
  cache: Map<string, CacheEntry>;
  cacheMessage: (
    channel: string,
    ts: string,
    value: { text?: string | null; user?: string | null; teamId?: string | null }
  ) => void;
  cacheKey: (channel: string, ts: string) => string;
  resolveChannelNameFromMap: (
    channelId: string | null | undefined,
    teamIdHint: string | undefined
  ) => string | undefined;
  resolveTeamId: (
    teamIdHint: string | undefined,
    channelId: string | null | undefined
  ) => string | undefined;
  resolveUserNameFromMap: (
    userId: string | null | undefined,
    teamIdHint: string | undefined,
    channelIdHint?: string | null | undefined
  ) => string | undefined;
  nameCacheRepository: SlackNameCacheRepository;
  responseBodyReader: ResponseBodyReader;
  responseProjector: SlackResponseProjector;
};

const REACTION_PAYLOAD_KEYS = [
  "reaction_added",
  "reaction_removed",
  "reactions.add",
  "reactions.remove",
];

export class SlackIngressHandlers {
  private readonly requestParser: SlackIngressRequestParser;
  private readonly wsNormalizer: SlackWsNormalizer;
  private readonly responseUpdater: SlackResponseCacheUpdater;

  constructor(private readonly deps: SlackIngressHandlersDeps) {
    this.requestParser = new SlackIngressRequestParser({
      slackApiRe: deps.slackApiRe,
      slackDebug: deps.slackDebug,
      pushDebugEvent: (kind, payload) => deps.pushDebugEvent(kind, payload),
      truncateForDebug: (value, max) => deps.truncateForDebug(value, max),
    });
    this.wsNormalizer = new SlackWsNormalizer({
      now: deps.now,
      timezone: deps.timezone,
      debugNotificationEnabled: deps.debugNotificationEnabled,
      slackDebug: deps.slackDebug,
      pushDebugEvent: (_kind, payload) => deps.pushDebugEvent("raw_ws", payload),
      cacheMessage: (channel, ts, value) => deps.cacheMessage(channel, ts, value),
      resolveChannelNameFromMap: (channelId, teamIdHint) =>
        deps.resolveChannelNameFromMap(channelId, teamIdHint),
      resolveTeamId: (teamIdHint, channelId) => deps.resolveTeamId(teamIdHint, channelId),
      resolveUserNameFromMap: (userId, teamIdHint, channelIdHint) =>
        deps.resolveUserNameFromMap(userId, teamIdHint, channelIdHint),
    });
    this.responseUpdater = new SlackResponseCacheUpdater({
      slackApiRe: deps.slackApiRe,
      debugFetchHookEnabled: deps.debugFetchHookEnabled,
      pushDebugEvent: (kind, payload) => deps.pushDebugEvent(kind, payload),
      truncateForDebug: (value, max) => deps.truncateForDebug(value, max),
      responseBodyReader: deps.responseBodyReader,
      responseProjector: deps.responseProjector,
      nameCacheRepository: deps.nameCacheRepository,
      cacheMessage: (channel, ts, value) => deps.cacheMessage(channel, ts, value),
      parseUrlInfo: (url) => this.requestParser.parseUrlInfo(url),
      normalizeHeader: (headers, key) => this.requestParser.normalizeHeader(headers, key),
      toTextFromBlocks: (blocks) => fromBlocks(blocks),
      logCacheUpdate: (kind, teamId, changed, total) =>
        this.logCacheUpdate(kind, teamId, changed, total),
    });
  }

  async handleRequest(event: FetchPausedEvent): Promise<NormalizedEvent[]> {
    const parsed = this.requestParser.parse(event);
    if (!parsed) {
      return [];
    }
    const { url, payload } = parsed;

    if (url.pathname.endsWith("/api/chat.postMessage")) {
      return this.handlePostMessageRequest(payload, event.frameId);
    }

    if (url.pathname.startsWith("/api/reactions.")) {
      return this.handleReactionRequest(payload, url.pathname, event.frameId);
    }

    return [];
  }

  async handleWebSocketFrame(
    event: WebSocketFrameEvent,
    direction: "received" | "sent"
  ): Promise<NormalizedEvent[]> {
    return this.wsNormalizer.normalize(event, direction);
  }

  async handleResponseReceived(event: ResponseReceivedEvent): Promise<void> {
    await this.responseUpdater.handleResponseReceived(event);
  }

  async handleRequestWillBeSent(event: RequestWillBeSentEvent): Promise<void> {
    await this.responseUpdater.handleRequestWillBeSent(event);
  }

  private async handlePostMessageRequest(
    payload: Record<string, unknown>,
    frameId?: string
  ): Promise<NormalizedEvent[]> {
    const channelId = typeof payload.channel === "string" ? payload.channel : "";
    const userId = typeof payload.user === "string" ? payload.user : undefined;
    const teamId = this.deps.resolveTeamId(this.asString(payload.team), channelId);
    const blocks = this.parseJsonIfString(payload.blocks) as Parameters<typeof fromBlocks>[0];
    const rawTs = this.asString(payload.ts);
    const slackTs = this.resolveMessageTs(rawTs ?? this.asString(payload.thread_ts));

    let domCaptured: {
      text?: string;
      channelName?: string | null;
      channelId?: string | null;
    } | null = null;
    if (channelId) {
      await this.deps.domCapture.capture({
        channelId,
        frameId,
        ts: slackTs,
        normalizedTs: this.normalizedTimestamp(slackTs) ?? slackTs,
      });
      domCaptured = this.deps.domCapture.consume(slackTs);
    }

    const channelNameHint = this.deps.resolveChannelNameFromMap(channelId, teamId) ?? channelId;
    const userNameHint =
      (userId ? this.deps.resolveUserNameFromMap(userId, teamId, channelId) : undefined) ??
      userId ??
      "unknown";

    const messageEvent = normalizeSlackMessage(
      {
        channel: { id: channelId, name: channelNameHint },
        user: { id: userId ?? "unknown", name: userNameHint },
        ts: slackTs,
        text: payload.text as string | undefined,
        blocks,
        thread_ts: payload.thread_ts as string | undefined,
        raw_ts: rawTs,
      },
      { now: this.deps.now(), timezone: this.deps.timezone }
    );

    if (channelId) {
      const textFromDom = domCaptured?.text ?? undefined;
      const fallbackText = (payload.text as string | undefined) ?? fromBlocks(blocks);
      const resolvedText = textFromDom ?? fallbackText;
      this.deps.cacheMessage(channelId, slackTs, {
        text: resolvedText,
        user: userId,
        teamId,
      });
      if (rawTs && rawTs !== slackTs) {
        this.deps.cacheMessage(channelId, rawTs, {
          text: resolvedText,
          user: userId,
          teamId,
        });
      }
    }

    return [messageEvent];
  }

  private async handleReactionRequest(
    payload: Record<string, unknown>,
    pathname: string,
    frameId?: string
  ): Promise<NormalizedEvent[]> {
    const item = this.asRecord(payload.item);
    const channelId = this.asString(payload.channel) ?? this.asString(item?.channel) ?? "";
    const rawItemTs = this.asString(payload.timestamp) ?? this.asString(item?.ts);
    const normalizedItemTs = this.normalizedTimestamp(rawItemTs);
    const fallbackItemTs = this.resolveMessageTs(undefined);
    const action = pathname.endsWith(".add")
      ? "added"
      : pathname.endsWith(".remove")
        ? "removed"
        : "added";
    const userId = this.asString(payload.user) ?? "unknown";
    const reactionName = this.asString(payload.name) ?? this.asString(payload.reaction);
    const eventTs = this.asString(payload.event_ts);
    const itemTsForEvent = rawItemTs ?? normalizedItemTs ?? fallbackItemTs;
    if (!channelId || !itemTsForEvent || !reactionName) {
      this.deps.slackDebug.debug("reaction payload missing fields", {
        channelId,
        itemTs: itemTsForEvent,
        reactionName,
        payload: this.deps.slackDebug.redactPayload(payload),
      });
      return [];
    }

    const candidate = this.buildReactionDomCandidate({
      ...(payload as Record<string, unknown>),
      frame_id: frameId,
      channel: channelId,
      channel_id: channelId,
      reaction: reactionName,
      timestamp: rawItemTs,
      item,
    });
    if (candidate) {
      await this.deps.domCapture.capture(candidate);
    }

    const domCaptured = this.deps.domCapture.consume(itemTsForEvent);
    if (domCaptured?.text) {
      this.deps.cacheMessage(channelId, itemTsForEvent, { text: domCaptured.text });
    }
    const domChannelId = domCaptured?.channelId ?? channelId;

    const lookupKeys = [rawItemTs, normalizedItemTs, fallbackItemTs]
      .filter((value): value is string => Boolean(value))
      .map((value) => this.deps.cacheKey(channelId, value));
    const cached = lookupKeys
      .map((key) => this.deps.cache.get(key))
      .find((entry): entry is CacheEntry => Boolean(entry));
    const messageText =
      domCaptured?.text ?? cached?.text ?? this.asString(payload.message_text) ?? undefined;
    const teamId =
      cached?.teamId ?? this.deps.resolveTeamId(this.asString(payload.team), channelId);
    const resolvedChannelName =
      this.deps.resolveChannelNameFromMap(domChannelId ?? channelId, teamId) ?? channelId;
    const userIdForEvent = cached?.user ?? userId;
    const userNameForEvent =
      this.deps.resolveUserNameFromMap(userIdForEvent, teamId, channelId) ?? userIdForEvent;

    const reactionEvent = normalizeSlackReaction(
      {
        channel: { id: channelId, name: resolvedChannelName },
        user: {
          id: userIdForEvent,
          name: userNameForEvent,
        },
        item_ts: itemTsForEvent,
        action,
        reaction: reactionName,
        event_ts: eventTs,
        message_text: messageText,
      },
      { now: this.deps.now(), timezone: this.deps.timezone }
    );
    return [reactionEvent];
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
    const frameId = this.asString(value.frame_id);

    const normalizedTs = this.normalizedTimestamp(tsCandidate) ?? tsCandidate;
    return {
      channelId: channelCandidate ?? null,
      frameId,
      ts: tsCandidate,
      normalizedTs,
    };
  }

  private logCacheUpdate(
    kind: "channel" | "user",
    teamId: string,
    changed: number,
    total: number
  ): void {
    const noun = kind === "channel" ? "channels" : "users";
    console.log(
      `[Adjutant] Slack ${kind} cache updated team=${teamId} changed=${changed} total_${noun}=${total}`
    );
  }

  private resolveMessageTs(ts: string | undefined): string {
    const normalized = this.normalizedTimestamp(ts);
    if (normalized) return normalized;
    const now = this.deps.now();
    const epochSeconds = Math.floor(now.getTime() / 1000);
    const millis = now.getMilliseconds();
    return `${epochSeconds}.${String(millis).padStart(3, "0")}000`;
  }

  private asString(value: unknown): string | undefined {
    return typeof value === "string" && value !== "" ? value : undefined;
  }

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    const parsed = this.parseJsonIfString(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  }

  private parseJsonIfString(value: unknown): unknown {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    if (!trimmed) return value;
    const prefix = trimmed[0];
    if (prefix !== "{" && prefix !== "[") return value;
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }

  private normalizedTimestamp(ts: string | undefined): string | null {
    if (!ts) return null;
    const parsed = Number.parseFloat(ts);
    if (!Number.isFinite(parsed)) return null;
    const seconds = Math.floor(parsed);
    const micros = Math.round((parsed - seconds) * 1_000_000);
    return `${seconds}.${String(micros).padStart(6, "0")}`;
  }
}
