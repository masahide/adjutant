import type { TimelineEvent } from "$lib/server/types";

export function resolveSlackPermalink(
  event: TimelineEvent,
  baseUrl: string | null | undefined
): string | null {
  if (!baseUrl || event.source !== "slack") {
    return null;
  }

  const origin = normalizeBaseUrl(baseUrl);
  if (!origin) {
    return null;
  }

  const slackDetail = extractSlackDetail(event.raw);
  if (!slackDetail) {
    return null;
  }

  const channelId = readString(slackDetail, "channel_id") ?? readString(slackDetail, "channelId");
  if (!channelId) {
    return null;
  }

  const messageTs =
    readString(slackDetail, "message_ts") ??
    readString(slackDetail, "ts") ??
    extractTimestampFromUid(event.uid);
  if (!messageTs) {
    return null;
  }

  const permalinkTs = formatSlackTimestamp(messageTs);
  if (!permalinkTs) {
    return null;
  }

  const url = new URL(origin);
  url.pathname = `/archives/${channelId}/p${permalinkTs}`;
  url.search = "";

  const threadTs = readString(slackDetail, "thread_ts");
  if (threadTs && threadTs !== messageTs) {
    url.searchParams.set("thread_ts", threadTs);
    url.searchParams.set("cid", channelId);
  }

  return url.toString();
}

function extractSlackDetail(raw: Record<string, unknown>): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const detail = (raw as Record<string, unknown>).detail;
  if (!detail || typeof detail !== "object") {
    return null;
  }
  const slack = (detail as Record<string, unknown>).slack;
  if (!slack || typeof slack !== "object") {
    return null;
  }
  return slack as Record<string, unknown>;
}

function normalizeBaseUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const base = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const parsed = new URL(base);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

function readString(scope: Record<string, unknown>, key: string): string | null {
  const value = scope[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function extractTimestampFromUid(uid: string): string | null {
  if (typeof uid !== "string") {
    return null;
  }
  const at = uid.indexOf("@");
  if (at === -1) {
    return null;
  }
  const rest = uid.slice(at + 1);
  const candidate = rest.split(":")[0] ?? "";
  return candidate.includes(".") ? candidate : null;
}

function formatSlackTimestamp(ts: string): string | null {
  const compact = ts.replace(/\./g, "");
  return /^\d+$/.test(compact) ? compact : null;
}
