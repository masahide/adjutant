import type { NormalizedEvent, SlackNotificationDetail } from "../core/events.js";
import { deriveSlackNotificationFields } from "./notification-derived-fields.js";

type RawPayload = Record<string, unknown>;

export type NotificationEventOptions = {
  now?: Date;
  timezone?: string;
  selfUserId?: string;
  selfUserIds?: readonly string[];
  workspaceHost?: string;
  workspaceHostsByTeam?: ReadonlyMap<string, string> | Readonly<Record<string, string>>;
};

const DEFAULT_TIMEZONE = "Asia/Tokyo";

export function normalizeDirectMentionNotificationFromRawPayload(
  payload: unknown,
  options: NotificationEventOptions = {}
): NormalizedEvent | undefined {
  const record = asRecord(payload);
  if (!record) {
    return undefined;
  }

  const derived = deriveSlackNotificationFields(record, {
    selfUserId: options.selfUserId,
    selfUserIds: options.selfUserIds,
    workspaceHost: options.workspaceHost,
    workspaceHostsByTeam: options.workspaceHostsByTeam,
  });
  if (derived.isDirectMention !== true) {
    return undefined;
  }
  if (!derived.channelId) {
    return undefined;
  }

  const eventTs =
    asString(record.event_ts) ?? asString(record.ts) ?? asString(record.message_ts) ?? undefined;
  const actorId = asString(record.user) ?? asString(record.user_id) ?? "unknown";
  const actor = actorId;
  const timezone = options.timezone ?? DEFAULT_TIMEZONE;
  const now = options.now ?? new Date();

  const detail: SlackNotificationDetail = {
    team_id: derived.teamId,
    workspace_host: options.workspaceHost,
    channel_id: derived.channelId,
    notification_type: "mention",
    title: asString(record.title),
    message_text: derived.messageText,
    user: actor,
    event_ts: eventTs,
    message_ts: derived.messageTs ?? eventTs,
    thread_ts: derived.threadTs,
    permalink: derived.permalink,
    mention_target_user_id: derived.mentionTargetUserId,
    is_direct_mention: true,
  };

  return {
    schema: "adjutant.event.v1.1",
    uid: `slack:${derived.channelId}@${eventTs ?? now.getTime()}:mention:${actorId}`,
    source: "slack",
    kind: "notification",
    actor,
    subject: derived.messageText ?? "mention",
    ts: slackTsToIso(eventTs, timezone, now),
    logged_at: now.toISOString(),
    meta: {
      notification_type: "mention",
      channel: derived.channelId,
      team_id: derived.teamId,
      mention_target_user_id: derived.mentionTargetUserId,
      workspace_host: options.workspaceHost,
    },
    detail: {
      slack: detail,
    },
  };
}

export function enrichNotificationEvent(
  event: NormalizedEvent,
  options: NotificationEventOptions = {}
): NormalizedEvent {
  if (event.kind !== "notification") {
    return event;
  }
  const slack = getSlackDetail(event);
  if (!slack) {
    return event;
  }

  const payload: RawPayload = {
    team_id: slack.team_id,
    workspace_host: slack.workspace_host,
    channel_id: slack.channel_id,
    notification_type: slack.notification_type,
    title: slack.title,
    text: slack.message_text,
    message_text: slack.message_text,
    user: slack.user,
    event_ts: slack.event_ts,
    message_ts: slack.message_ts ?? slack.event_ts,
    thread_ts: slack.thread_ts,
    permalink: slack.permalink,
    mention_target_user_id: slack.mention_target_user_id,
    is_direct_mention: slack.is_direct_mention,
  };
  const derived = deriveSlackNotificationFields(payload, {
    selfUserId: options.selfUserId,
    selfUserIds: options.selfUserIds,
    workspaceHost: options.workspaceHost,
    workspaceHostsByTeam: options.workspaceHostsByTeam,
  });
  const nextSlack: SlackNotificationDetail = {
    ...slack,
    team_id: slack.team_id ?? derived.teamId,
    workspace_host: slack.workspace_host ?? options.workspaceHost,
    message_ts: slack.message_ts ?? derived.messageTs,
    thread_ts: slack.thread_ts ?? derived.threadTs,
    permalink: slack.permalink ?? derived.permalink,
    mention_target_user_id: slack.mention_target_user_id ?? derived.mentionTargetUserId,
    is_direct_mention: slack.is_direct_mention ?? derived.isDirectMention,
  };

  return {
    ...event,
    meta: {
      ...(event.meta ?? {}),
      ...(nextSlack.team_id ? { team_id: nextSlack.team_id } : {}),
      ...(nextSlack.mention_target_user_id
        ? { mention_target_user_id: nextSlack.mention_target_user_id }
        : {}),
      ...(options.workspaceHost ? { workspace_host: options.workspaceHost } : {}),
    },
    detail: {
      slack: nextSlack,
    },
  };
}

export function isDirectMentionNotificationEvent(event: NormalizedEvent): boolean {
  if (event.kind !== "notification") {
    return false;
  }
  const slack = getSlackDetail(event);
  if (!slack) {
    return false;
  }
  return slack.notification_type === "mention" && slack.is_direct_mention === true;
}

function getSlackDetail(event: NormalizedEvent): SlackNotificationDetail | undefined {
  const detail = event.detail;
  if (!detail || typeof detail !== "object" || !("slack" in detail)) {
    return undefined;
  }
  return detail.slack as SlackNotificationDetail;
}

function asRecord(value: unknown): RawPayload | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as RawPayload;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function slackTsToIso(ts: string | undefined, timezone: string, fallback: Date): string {
  const timestamp = ts ? Number.parseFloat(ts) : Number.NaN;
  const epochMs = Number.isFinite(timestamp) ? Math.round(timestamp * 1000) : fallback.getTime();
  return formatInTimezone(new Date(epochMs), timezone);
}

function formatInTimezone(date: Date, timeZone: string): string {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const parts = dtf.formatToParts(date);
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const year = lookup.year ?? "0000";
  const month = lookup.month ?? "01";
  const day = lookup.day ?? "01";
  const hour = lookup.hour ?? "00";
  const minute = lookup.minute ?? "00";
  const second = lookup.second ?? "00";

  const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}`;
  const asUtc = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second)
  );

  const offsetMinutes = Math.round((asUtc - date.getTime()) / 60000);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const offsetHours = String(Math.floor(abs / 60)).padStart(2, "0");
  const offsetMins = String(abs % 60).padStart(2, "0");

  return `${iso}${sign}${offsetHours}:${offsetMins}`;
}
