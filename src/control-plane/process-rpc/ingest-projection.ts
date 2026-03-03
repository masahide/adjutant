import type { CollectorIngestRequest } from "../../contracts/process-rpc/method-types.js";
import type { NormalizedEvent } from "../../core/events.js";

export interface IngestProjection {
  sessionKey: string;
  message: string;
  dedupeKey: string;
  source: "slack";
  occurredAt: string;
  rawEvent: NormalizedEvent;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function slackDetail(event: NormalizedEvent): Record<string, unknown> {
  const detail = event.detail;
  if (!isObject(detail)) {
    return {};
  }
  if (!("slack" in detail)) {
    return {};
  }
  const slack = detail.slack;
  if (!isObject(slack)) {
    return {};
  }
  return slack;
}

function resolveChannelId(event: NormalizedEvent): string {
  return asString(slackDetail(event).channel_id) ?? "unknown";
}

function resolveThreadTs(event: NormalizedEvent): string | undefined {
  const detail = slackDetail(event);
  const threadTs = asString(detail.thread_ts);
  if (threadTs !== undefined) {
    return threadTs;
  }
  if (event.kind === "reaction") {
    return asString(detail.message_ts);
  }
  return undefined;
}

export function resolveSlackSessionKey(event: NormalizedEvent): string {
  const channelId = resolveChannelId(event);
  const threadTs = resolveThreadTs(event);

  if (threadTs !== undefined) {
    return `slack:channel:${channelId}:thread:${threadTs}`;
  }
  if (channelId.startsWith("G")) {
    return `slack:group:${channelId}`;
  }
  if (channelId.startsWith("D")) {
    return `slack:${channelId}`;
  }
  return `slack:channel:${channelId}`;
}

export function projectSlackPrompt(event: NormalizedEvent): string {
  const detail = slackDetail(event);
  const channelId = resolveChannelId(event);

  if (event.kind === "post") {
    const text = asString(detail.text) ?? "";
    return `[Slack post] channel=${channelId} text=${text}`;
  }

  if (event.kind === "reaction") {
    const emoji = asString(detail.emoji) ?? "unknown";
    const messageText = asString(detail.message_text) ?? "";
    return `[Slack reaction] channel=${channelId} emoji=${emoji} message=${messageText}`;
  }

  if (event.kind === "notification") {
    const type = asString(detail.notification_type) ?? "unknown";
    const messageText = asString(detail.message_text) ?? "";
    return `[Slack notification] type=${type} channel=${channelId} message=${messageText}`;
  }

  return `[Slack event] kind=${event.kind} channel=${channelId}`;
}

export function projectCollectorIngestRequest(input: CollectorIngestRequest): IngestProjection {
  return {
    sessionKey: resolveSlackSessionKey(input.payload),
    message: projectSlackPrompt(input.payload),
    dedupeKey: input.dedupeKey,
    source: input.source,
    occurredAt: input.occurredAt,
    rawEvent: input.payload,
  };
}
