import type { NormalizedEvent } from "../core/events.js";
import { fromBlocks } from "./blocks.js";
import {
  normalizeSlackMessage,
  normalizeSlackNotification,
  normalizeSlackReaction,
} from "./normalize.js";
import type { ReactionDomCandidate } from "./domCaptureService.js";
import { SlackNameCacheRepository } from "./nameCacheRepository.js";
import { ResponseBodyReader } from "./responseBodyReader.js";
import { SlackResponseProjector } from "./responseProjector.js";
import { SlackDebug } from "./slackDebug.js";

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

const JSONISH_PAYLOAD_KEYS = new Set(["blocks", "item", "attachments", "metadata", "message"]);

export class SlackIngressHandlers {
  constructor(private readonly deps: SlackIngressHandlersDeps) {}

  async handleRequest(event: FetchPausedEvent): Promise<NormalizedEvent[]> {
    if (event.request.method !== "POST") return [];
    if (!this.deps.slackApiRe.test(event.request.url)) return [];

    const body = event.request.postData ?? "";
    const contentType = this.normalizeHeader(event.request.headers, "content-type");
    this.deps.pushDebugEvent("raw_fetch", {
      method: event.request.method,
      url: event.request.url,
      urlInfo: this.parseUrlInfo(event.request.url),
      contentType,
      body: this.deps.truncateForDebug(body, 4000),
    });

    const url = new URL(event.request.url);
    const parsedPayload = this.parseBody(body, contentType);
    const payload = parsedPayload ? this.normalizeParsedPayload(parsedPayload) : null;
    if (!payload) {
      this.deps.slackDebug.debug("parseBody returned null", {
        url: event.request.url,
        contentType,
      });
      return [];
    }

    this.deps.slackDebug.verbose("parsed payload", this.deps.slackDebug.redactPayload(payload));

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
    const payload = event.response.payloadData;
    if (!payload || payload.length > 512 * 1024) return [];

    try {
      const data = JSON.parse(payload);
      if (direction === "received") {
        this.deps.pushDebugEvent("raw_ws", data);
      }

      if (data?.type === "message" && data.channel && data.ts) {
        const text = fromBlocks(data.blocks);
        this.deps.cacheMessage(data.channel, data.ts, {
          text,
          user: data.user,
          teamId: this.asString(data.team),
        });
      } else if (data?.type === "message_changed" && data.channel && data.message?.ts) {
        const msg = data.message;
        const text = fromBlocks(msg.blocks);
        this.deps.cacheMessage(data.channel, msg.ts, {
          text,
          user: msg.user,
          teamId: this.asString(msg.team) ?? this.asString(data.team),
        });
      } else if (data?.type === "thread_broadcast" && data.channel && data.root_ts) {
        const text = fromBlocks(data.blocks);
        this.deps.cacheMessage(data.channel, data.root_ts, {
          text,
          user: data.user,
          teamId: this.asString(data.team),
        });
      }

      if (direction !== "received") return [];

      const notifications: NormalizedEvent[] = [];
      for (const candidate of this.collectNotificationCandidates(data)) {
        const notificationEvent = this.normalizeNotificationFromSocket(candidate);
        if (notificationEvent) {
          notifications.push(notificationEvent);
        }
      }
      return notifications;
    } catch {
      return [];
    }
  }

  async handleResponseReceived(event: ResponseReceivedEvent): Promise<void> {
    if (this.deps.debugFetchHookEnabled) {
      await this.pushResponseDebugEvent(event);
    }
    await this.refreshChannelNamesFromResponses(event);
    await this.refreshUserNameFromUsersList(event);
    if (!this.deps.slackApiRe.test(event.response.url)) return;

    try {
      const json = await this.deps.responseBodyReader.readJson(event.requestId);
      if (!json.data || json.invalidJson) return;
      const data = this.asRecord(json.data);
      if (!data) return;
      const message = this.asRecord(data.message ?? data.item);
      const channel = this.asString(message?.channel);
      const ts = this.asString(message?.ts);
      if (channel && ts) {
        const text = fromBlocks(message?.blocks);
        this.deps.cacheMessage(channel, ts, { text, user: this.asString(message?.user) });
      }
    } catch {
      // ignore errors
    }
  }

  async handleRequestWillBeSent(event: RequestWillBeSentEvent): Promise<void> {
    if (!this.deps.debugFetchHookEnabled) return;
    if (!event?.request?.url || !event?.request?.method) return;

    const resourceType = this.asString(event.type) ?? "";
    if (resourceType && resourceType !== "Fetch" && resourceType !== "XHR") return;

    const initiatorType = this.asString(event.initiator?.type);
    const body = event.request.postData ?? "";
    const contentType = this.normalizeHeader(event.request.headers, "content-type");
    this.deps.pushDebugEvent("raw_fetch", {
      stage: "requestWillBeSent",
      requestId: event.requestId,
      resourceType: resourceType || undefined,
      initiatorType,
      method: event.request.method,
      url: event.request.url,
      urlInfo: this.parseUrlInfo(event.request.url),
      contentType,
      body: this.deps.truncateForDebug(body, 4000),
    });
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

  private normalizeNotificationFromSocket(data: Record<string, unknown>): NormalizedEvent | null {
    const type = this.asString(data.type) ?? "";
    const subtype = this.asString(data.subtype) ?? "";
    const eventType = (type === "message" && subtype) || type || subtype;
    const suppressNotification = data.suppress_notification;
    const isSuppressed =
      suppressNotification === true ||
      suppressNotification === 1 ||
      suppressNotification === "1" ||
      suppressNotification === "true";
    const isBotMessageNotification =
      type === "message" &&
      subtype === "bot_message" &&
      !isSuppressed &&
      this.asString(data.bot_id) !== undefined;
    const looksLikeNotification =
      eventType.toLowerCase().includes("notification") ||
      this.asString(data.title) !== undefined ||
      this.asString(data.subtitle) !== undefined ||
      this.asString(data.body) !== undefined ||
      this.asString(data.preview) !== undefined ||
      isBotMessageNotification;
    if (!looksLikeNotification) return null;

    const channelId =
      this.asString(data.channel) ?? this.asString(data.channel_id) ?? this.asString(data.room);
    const teamId = this.deps.resolveTeamId(
      this.asString(data.team_id) ?? this.asString(data.team),
      channelId
    );
    const channelName = this.deps.resolveChannelNameFromMap(channelId, teamId) ?? channelId;
    const userId = this.asString(data.user) ?? this.asString(data.user_id);
    const botProfile = this.asRecord(data.bot_profile);
    const botName = this.asString(data.bot_name) ?? this.asString(botProfile?.name);
    const userName =
      this.deps.resolveUserNameFromMap(userId, teamId, channelId) ?? botName ?? userId ?? "unknown";
    const ts = this.asString(data.event_ts) ?? this.asString(data.ts);
    const title =
      this.asString(data.title) ?? this.asString(data.subtitle) ?? this.asString(data.summary);
    const text =
      this.asString(data.text) ??
      this.asString(data.body) ??
      this.asString(data.message) ??
      this.asString(data.preview);

    const normalized = normalizeSlackNotification(
      {
        channel: { id: channelId, name: channelName },
        user: { id: userId, name: userName },
        type: eventType || "notification",
        ts,
        event_ts: ts,
        title,
        message_text: text,
      },
      { now: this.deps.now(), timezone: this.deps.timezone }
    );
    if (this.deps.debugNotificationEnabled) {
      this.deps.slackDebug.debug("notification captured", {
        type: normalized.meta?.notification_type,
        channel: normalized.meta?.channel,
        title,
      });
    }
    return normalized;
  }

  private collectNotificationCandidates(value: unknown): Record<string, unknown>[] {
    const queue: unknown[] = [value];
    const result: Record<string, unknown>[] = [];
    const visited = new Set<unknown>();

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || visited.has(current)) continue;
      visited.add(current);

      if (Array.isArray(current)) {
        for (const item of current) queue.push(item);
        continue;
      }
      if (typeof current !== "object") continue;

      const record = current as Record<string, unknown>;
      result.push(record);

      for (const key of ["event", "payload", "data", "message", "item", "notification"]) {
        if (key in record) queue.push(record[key]);
      }
      if (Array.isArray(record.notifications)) {
        queue.push(record.notifications);
      }
    }

    return result;
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

  private async pushResponseDebugEvent(event: ResponseReceivedEvent): Promise<void> {
    const resourceType = this.asString(event.type) ?? "";
    if (resourceType && resourceType !== "Fetch" && resourceType !== "XHR") return;
    if (!event?.response?.url) return;

    const contentType =
      this.normalizeHeader(event.response.headers, "content-type") || event.response.mimeType || "";

    const bodyResult = await this.deps.responseBodyReader.readText(event.requestId);
    const bodyText = bodyResult.text;
    const bodyUnavailable = bodyResult.unavailable ? "unavailable" : null;

    const preview = this.previewResponseBody(bodyText, contentType);
    this.deps.pushDebugEvent("raw_fetch", {
      stage: "responseReceived",
      requestId: event.requestId,
      resourceType: resourceType || undefined,
      url: event.response.url,
      urlInfo: this.parseUrlInfo(event.response.url),
      status: event.response.status,
      statusText: event.response.statusText,
      contentType: contentType || undefined,
      body: preview.body,
      bodyType: preview.bodyType,
      bodyUnavailable,
    });
  }

  private async refreshChannelNamesFromResponses(event: ResponseReceivedEvent): Promise<void> {
    const urlInfo = this.parseUrlInfo(event.response.url);
    if (!urlInfo) return;

    const segments = urlInfo.pathSegments ?? [];
    const looksLikeChannelsInfo =
      segments.length >= 4 &&
      segments[0] === "cache" &&
      segments[2] === "channels" &&
      segments[3] === "info";
    const looksLikeChannelsSearch =
      segments.length >= 4 &&
      segments[0] === "cache" &&
      segments[2] === "channels" &&
      segments[3] === "search";
    const looksLikeConversationsView = urlInfo.pathname === "/api/conversations.view";
    const looksLikeGenericInfo = urlInfo.pathname === "/api/conversations.genericInfo";
    const looksLikeSearchModulesChannels = urlInfo.pathname === "/api/search.modules.channels";
    const looksLikeClientUserBoot = urlInfo.pathname === "/api/client.userBoot";
    if (
      !looksLikeChannelsInfo &&
      !looksLikeChannelsSearch &&
      !looksLikeConversationsView &&
      !looksLikeGenericInfo &&
      !looksLikeSearchModulesChannels &&
      !looksLikeClientUserBoot
    ) {
      return;
    }

    try {
      const json = await this.deps.responseBodyReader.readJson(event.requestId);
      if (!json.data || json.invalidJson) return;

      let projectedChannels: Array<{ teamId: string; channelId: string; channelName: string }> = [];
      if (looksLikeConversationsView) {
        const projected = this.deps.responseProjector.projectConversationsView(json.data);
        if (projected) {
          projectedChannels = [projected];
        }
      } else if (looksLikeChannelsInfo) {
        projectedChannels = this.deps.responseProjector.projectChannelsInfo(json.data, urlInfo);
      } else if (looksLikeChannelsSearch) {
        projectedChannels = this.deps.responseProjector.projectChannelsSearch(json.data, urlInfo);
      } else if (looksLikeGenericInfo) {
        projectedChannels = this.deps.responseProjector.projectConversationsGenericInfo(
          json.data,
          urlInfo
        );
      } else if (looksLikeSearchModulesChannels) {
        projectedChannels = this.deps.responseProjector.projectSearchModulesChannels(
          json.data,
          urlInfo
        );
      } else if (looksLikeClientUserBoot) {
        projectedChannels = this.deps.responseProjector.projectClientUserBoot(json.data);
      }
      if (projectedChannels.length === 0) return;

      const changes = await this.deps.nameCacheRepository.updateChannels(projectedChannels);
      for (const changed of changes) {
        this.logCacheUpdate("channel", changed.teamId, changed.changed, changed.total);
      }
    } catch {
      // ignore channel metadata parse errors
    }
  }

  private async refreshUserNameFromUsersList(event: ResponseReceivedEvent): Promise<void> {
    const urlInfo = this.parseUrlInfo(event.response.url);
    if (!urlInfo) return;
    const segments = urlInfo.pathSegments ?? [];
    const looksLikeUserList =
      (segments.length >= 4 &&
        segments[0] === "cache" &&
        segments[2] === "users" &&
        segments[3] === "list") ||
      urlInfo.pathname === "/api/users.list";
    if (!looksLikeUserList) return;

    try {
      const json = await this.deps.responseBodyReader.readJson(event.requestId);
      if (!json.data || json.invalidJson) return;
      const projectedUsers = this.deps.responseProjector.projectUsersList(json.data, urlInfo);
      const changes = await this.deps.nameCacheRepository.updateUsers(projectedUsers);
      for (const changed of changes) {
        this.logCacheUpdate("user", changed.teamId, changed.changed, changed.total);
      }
    } catch {
      // ignore users/list parse errors
    }
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

  private previewResponseBody(
    bodyText: string | null,
    contentType: string
  ): { body: unknown; bodyType: "json" | "text" | "empty" } {
    if (!bodyText) {
      return { body: undefined, bodyType: "empty" };
    }

    const trimmed = bodyText.trim();
    const likelyJson =
      contentType.toLowerCase().includes("application/json") ||
      trimmed.startsWith("{") ||
      trimmed.startsWith("[");
    if (likelyJson) {
      try {
        return { body: JSON.parse(trimmed), bodyType: "json" };
      } catch {
        // Fall back to text when JSON parse fails.
      }
    }

    return { body: this.deps.truncateForDebug(bodyText, 4000), bodyType: "text" };
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

  private parseUrlInfo(url: string): {
    protocol?: string;
    origin?: string;
    host?: string;
    hostname?: string;
    port?: string;
    pathname?: string;
    pathSegments?: string[];
    search?: string;
    query?: Record<string, string | string[]>;
    hash?: string;
  } | null {
    if (!url) return null;
    try {
      const parsed = new URL(url);
      const query: Record<string, string | string[]> = {};
      for (const [key, value] of parsed.searchParams.entries()) {
        if (key in query) {
          const current = query[key];
          query[key] = Array.isArray(current) ? [...current, value] : [current, value];
        } else {
          query[key] = value;
        }
      }
      return {
        protocol: parsed.protocol,
        origin: parsed.origin,
        host: parsed.host,
        hostname: parsed.hostname,
        port: parsed.port || undefined,
        pathname: parsed.pathname,
        pathSegments: parsed.pathname.split("/").filter((segment) => segment.length > 0),
        search: parsed.search || undefined,
        query: Object.keys(query).length > 0 ? query : undefined,
        hash: parsed.hash || undefined,
      };
    } catch {
      return null;
    }
  }

  private parseBody(body: string, contentType: string): Record<string, unknown> | null {
    if (!body) return {};
    if (/application\/json|text\/json/i.test(contentType) || body.trim().startsWith("{")) {
      try {
        return JSON.parse(body);
      } catch {
        this.deps.slackDebug.debug("failed to parse JSON body");
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
              this.deps.slackDebug.debug("failed to parse nested payload JSON");
            }
          }
        }
        return result;
      } catch {
        this.deps.slackDebug.debug("failed to parse form body");
        return null;
      }
    }

    if (/multipart\/form-data/i.test(contentType)) {
      const boundaryMatch = contentType.match(/boundary=([^;]+)/i);
      if (!boundaryMatch) {
        this.deps.slackDebug.debug("missing multipart boundary");
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
            this.deps.slackDebug.debug("failed to parse multipart payload JSON");
          }
        }
      }

      return result;
    }

    return null;
  }

  private normalizeParsedPayload(payload: Record<string, unknown>): Record<string, unknown> {
    const normalized: Record<string, unknown> = { ...payload };
    for (const [key, value] of Object.entries(normalized)) {
      if (!JSONISH_PAYLOAD_KEYS.has(key)) continue;
      normalized[key] = this.parseJsonIfString(value);
    }
    return normalized;
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
