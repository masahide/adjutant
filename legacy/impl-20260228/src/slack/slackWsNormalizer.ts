import type { NormalizedEvent } from "../core/events.js";
import { fromBlocks } from "./blocks.js";
import { normalizeSlackNotification } from "./normalize.js";
import type { SlackDebug } from "./slackDebug.js";
import type { WebSocketFrameEvent } from "./slackIngressHandlers.js";

type SlackWsNormalizerDeps = {
  now: () => Date;
  timezone: string;
  debugNotificationEnabled: boolean;
  slackDebug: SlackDebug;
  pushDebugEvent: (kind: "raw_ws", payload: unknown) => void;
  cacheMessage: (
    channel: string,
    ts: string,
    value: { text?: string | null; user?: string | null; teamId?: string | null }
  ) => void;
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
};

export class SlackWsNormalizer {
  constructor(private readonly deps: SlackWsNormalizerDeps) {}

  normalize(event: WebSocketFrameEvent, direction: "received" | "sent"): NormalizedEvent[] {
    const payload = event.response.payloadData;
    if (!payload || payload.length > 512 * 1024) return [];

    try {
      const data = JSON.parse(payload) as Record<string, unknown>;
      if (direction === "received") {
        this.deps.pushDebugEvent("raw_ws", data);
      }

      if (data?.type === "message" && data.channel && data.ts) {
        const channel = this.asString(data.channel);
        const ts = this.asString(data.ts);
        if (channel && ts) {
          const text = fromBlocks(data.blocks);
          this.deps.cacheMessage(channel, ts, {
            text,
            user: this.asString(data.user),
            teamId: this.asString(data.team),
          });
        }
      } else if (
        data?.type === "message_changed" &&
        data.channel &&
        this.asRecord(data.message)?.ts
      ) {
        const msg = this.asRecord(data.message) as Record<string, unknown>;
        const channel = this.asString(data.channel);
        const ts = this.asString(msg.ts);
        if (channel && ts) {
          const text = fromBlocks(msg.blocks);
          this.deps.cacheMessage(channel, ts, {
            text,
            user: this.asString(msg.user),
            teamId: this.asString(msg.team) ?? this.asString(data.team),
          });
        }
      } else if (data?.type === "thread_broadcast" && data.channel && data.root_ts) {
        const channel = this.asString(data.channel);
        const rootTs = this.asString(data.root_ts);
        if (channel && rootTs) {
          const text = fromBlocks(data.blocks);
          this.deps.cacheMessage(channel, rootTs, {
            text,
            user: this.asString(data.user),
            teamId: this.asString(data.team),
          });
        }
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

  private asString(value: unknown): string | undefined {
    return typeof value === "string" && value !== "" ? value : undefined;
  }

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    return value as Record<string, unknown>;
  }
}
