import type { NormalizedEvent } from "../core/events.js";

const DEFAULT_TIMEZONE = "Asia/Tokyo";

export type SlackMessagePayload = {
  channel: { id: string; name?: string };
  user: { id: string; name?: string };
  ts: string;
  raw_ts?: string;
  text?: string;
  blocks?: unknown;
  thread_ts?: string;
};

export type SlackReactionPayload = {
  channel: { id: string; name?: string };
  user: { id: string; name?: string };
  item_ts: string;
  action: "added" | "removed";
  reaction: string;
  event_ts?: string;
  message_text?: string | null;
};

export type NormalizeOptions = {
  now?: Date;
  timezone?: string;
};

export function normalizeSlackMessage(
  payload: SlackMessagePayload,
  options: NormalizeOptions = {}
): NormalizedEvent {
  const { channel, user, ts, text, blocks, thread_ts, raw_ts } = payload;
  const timezone = options.timezone ?? DEFAULT_TIMEZONE;
  const channelName = channel.name ?? channel.id;
  const actor = user.name ?? user.id;
  const subjectText = text ?? "";
  const canonicalTs = ts;
  const rawTs = raw_ts ?? ts;
  const isoTs = slackTsToIso(canonicalTs, timezone, options.now);
  const loggedAt = formatInTimezone(options.now ?? new Date(), timezone);

  return {
    schema: "reaclog.event.v1.1",
    source: "slack",
    kind: "post",
    uid: `slack:${channel.id}@${rawTs}`,
    actor,
    subject: `[#${channelName}] ${subjectText}`.trim(),
    ts: isoTs,
    logged_at: loggedAt,
    meta: {
      channel: `#${channelName}`,
    },
    detail: {
      slack: {
        channel_id: channel.id,
        channel_name: channel.name,
        text,
        blocks,
        thread_ts,
        message_ts: rawTs,
      },
    },
  };
}

export function normalizeSlackReaction(
  payload: SlackReactionPayload,
  options: NormalizeOptions = {}
): NormalizedEvent {
  const { channel, user, item_ts, action, reaction, event_ts, message_text } = payload;
  const timezone = options.timezone ?? DEFAULT_TIMEZONE;
  const channelName = channel.name ?? channel.id;
  const actorId = user.id ?? "unknown";
  const actorName = user.name ?? actorId;
  const actor = actorName;
  const ts = event_ts ?? item_ts;
  const uniqueSuffix = `${item_ts}:${reaction}:${action}:${actorId}`;

  return {
    schema: "reaclog.event.v1.1",
    source: "slack",
    kind: "reaction",
    action,
    uid: `slack:${channel.id}@${uniqueSuffix}`,
    actor,
    subject: `[#${channelName}] reaction ${reaction}`,
    ts: slackTsToIso(ts, timezone, options.now),
    logged_at: formatInTimezone(options.now ?? new Date(), timezone),
    meta: {
      channel: `#${channelName}`,
      emoji: reaction,
    },
    detail: {
      slack: {
        channel_id: channel.id,
        channel_name: channel.name,
        message_ts: item_ts,
        emoji: reaction,
        user: actor,
        message_text: message_text ?? undefined,
      },
    },
  };
}

const slackTsToIso = (ts: string, timezone: string, fallback?: Date): string => {
  const timestamp = Number.parseFloat(ts);
  const isValid = Number.isFinite(timestamp);
  const epochMs = isValid ? Math.round(timestamp * 1000) : (fallback?.getTime() ?? Date.now());
  return formatInTimezone(new Date(epochMs), timezone);
};

const formatInTimezone = (date: Date, timeZone: string): string => {
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
};
