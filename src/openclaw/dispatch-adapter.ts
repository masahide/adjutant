import { createHash } from "node:crypto";
import type { NormalizedEvent } from "../core/events.js";
import type { PostChatMessageRequest } from "../assistant/api-types.js";
import {
  resolveAgentRoute,
  resolveThreadSessionKeys,
  type ResolveAgentRouteInput,
} from "./session-route-resolver.js";

const DEFAULT_MAX_DISPATCH_CHARS = 4000;
const DEFAULT_MAX_EVENT_UIDS_PER_DISPATCH = 50;
const REACTION_TRIGGER_MESSAGE =
  "[Slack trigger] New reaction events were observed in this session.";
const NOTIFICATION_TRIGGER_MESSAGE =
  "[Slack trigger] New notification events were observed in this session.";
const TRUNCATION_MARKER = "\n...[truncated]...\n";

type DispatchMessageStats = {
  message: string;
  messageTruncated?: boolean;
  originalCharCount?: number;
  dispatchedCharCount?: number;
};

export type ChatDispatchRequest = {
  message: string;
  sessionKey: string;
  accountId: string;
  idempotencyKey: string;
  eventUids: string[];
  uidOverflowCount?: number;
  messageTruncated?: boolean;
  originalCharCount?: number;
  dispatchedCharCount?: number;
  messageIds?: string[];
  runTarget?: "main" | "session";
  originSessionKey?: string;
};

export type DispatchAdapterInput = {
  events: NormalizedEvent[];
  accountId: string;
  originSessionKey?: string;
  runTarget?: ResolveAgentRouteInput["runTarget"];
  mainSessionKey?: string;
  maxDispatchChars?: number;
  maxEventUidsPerDispatch?: number;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as Record<string, unknown>;
}

function extractSlackDetail(event: NormalizedEvent): Record<string, unknown> | null {
  const detail = asRecord(event.detail);
  if (!detail) {
    return null;
  }
  return asRecord(detail.slack);
}

function extractText(event: NormalizedEvent): string | null {
  if (event.kind !== "post") {
    return null;
  }
  const slack = extractSlackDetail(event);
  const text = slack?.text;
  if (typeof text === "string" && text.trim().length > 0) {
    return text.trim();
  }
  return null;
}

function extractMessageTs(event: NormalizedEvent): string | null {
  const slack = extractSlackDetail(event);
  const messageTs = slack?.message_ts;
  if (typeof messageTs === "string" && messageTs.trim().length > 0) {
    return messageTs.trim();
  }
  return null;
}

function buildDispatchMessage(events: NormalizedEvent[]): string {
  const postLines: string[] = [];
  let hasReaction = false;
  let hasNotification = false;

  for (const event of events) {
    if (event.kind === "post") {
      const text = extractText(event);
      if (text) {
        postLines.push(text);
      }
      continue;
    }
    if (event.kind === "reaction") {
      hasReaction = true;
      continue;
    }
    if (event.kind === "notification") {
      hasNotification = true;
      continue;
    }
  }

  const lines = [...postLines];
  if (hasReaction) {
    lines.push(REACTION_TRIGGER_MESSAGE);
  }
  if (hasNotification) {
    lines.push(NOTIFICATION_TRIGGER_MESSAGE);
  }
  return lines.join("\n").trim();
}

function buildMessageStats(message: string, maxDispatchChars: number): DispatchMessageStats {
  if (message.length <= maxDispatchChars) {
    return { message };
  }

  if (maxDispatchChars <= TRUNCATION_MARKER.length + 2) {
    const clipped = message.slice(0, maxDispatchChars);
    return {
      message: clipped,
      messageTruncated: true,
      originalCharCount: message.length,
      dispatchedCharCount: clipped.length,
    };
  }

  const keepLength = maxDispatchChars - TRUNCATION_MARKER.length;
  const headLength = Math.ceil(keepLength / 2);
  const tailLength = Math.floor(keepLength / 2);
  const clipped = `${message.slice(0, headLength)}${TRUNCATION_MARKER}${message.slice(-tailLength)}`;
  const dispatched =
    clipped.length > maxDispatchChars ? clipped.slice(0, maxDispatchChars) : clipped;
  return {
    message: dispatched,
    messageTruncated: true,
    originalCharCount: message.length,
    dispatchedCharCount: dispatched.length,
  };
}

function buildIdempotencyKey(sessionKey: string, sortedUids: string[]): string {
  const base = `${sessionKey}\n${sortedUids.join("\n")}`;
  return `sha256:${createHash("sha256").update(base).digest("hex")}`;
}

function resolveOriginSessionKey(events: NormalizedEvent[], accountId: string): string {
  const first = events[0];
  if (!first) {
    throw new Error("events is required");
  }
  const slack = extractSlackDetail(first);
  const channelId = typeof slack?.channel_id === "string" ? slack.channel_id : undefined;
  const threadTs = typeof slack?.thread_ts === "string" ? slack.thread_ts : undefined;
  return resolveThreadSessionKeys({
    accountId,
    channelId,
    threadTs,
  }).sessionKey;
}

function normalizeUids(events: NormalizedEvent[]): string[] {
  const unique = new Set<string>();
  for (const event of events) {
    const uid = event.uid?.trim();
    if (uid) {
      unique.add(uid);
    }
  }
  return Array.from(unique).sort((a, b) => a.localeCompare(b));
}

export function toChatDispatchRequest(input: DispatchAdapterInput): ChatDispatchRequest {
  const accountId = input.accountId?.trim();
  if (!accountId) {
    throw new Error("accountId is required");
  }
  if (!Array.isArray(input.events) || input.events.length === 0) {
    throw new Error("events is required");
  }

  const originSessionKey =
    input.originSessionKey?.trim() ?? resolveOriginSessionKey(input.events, accountId);
  const route = resolveAgentRoute({
    runTarget: input.runTarget,
    originSessionKey,
    mainSessionKey: input.mainSessionKey,
  });

  const message = buildDispatchMessage(input.events);
  if (!message) {
    throw new Error("dispatch message is empty");
  }

  const sortedUids = normalizeUids(input.events);
  if (sortedUids.length === 0) {
    throw new Error("eventUids is required");
  }
  const maxEventUidsPerDispatch = Math.max(
    1,
    Math.floor(input.maxEventUidsPerDispatch ?? DEFAULT_MAX_EVENT_UIDS_PER_DISPATCH)
  );
  const eventUids = sortedUids.slice(0, maxEventUidsPerDispatch);
  const uidOverflowCount = sortedUids.length - eventUids.length;

  const messageIds = Array.from(
    new Set(
      input.events
        .filter((event) => event.kind === "post")
        .map((event) => extractMessageTs(event))
        .filter((messageTs): messageTs is string => Boolean(messageTs))
    )
  );

  const messageStats = buildMessageStats(
    message,
    Math.max(1, Math.floor(input.maxDispatchChars ?? DEFAULT_MAX_DISPATCH_CHARS))
  );

  return {
    message: messageStats.message,
    sessionKey: route.sessionKey,
    accountId,
    idempotencyKey: buildIdempotencyKey(route.sessionKey, sortedUids),
    eventUids,
    uidOverflowCount: uidOverflowCount > 0 ? uidOverflowCount : undefined,
    messageTruncated: messageStats.messageTruncated,
    originalCharCount: messageStats.originalCharCount,
    dispatchedCharCount: messageStats.dispatchedCharCount,
    messageIds: messageIds.length > 0 ? messageIds : undefined,
    runTarget: route.runTarget,
    originSessionKey: route.originSessionKey,
  };
}

export function toApiRequest(dispatch: ChatDispatchRequest): PostChatMessageRequest {
  if (!dispatch.message || dispatch.message.trim().length === 0) {
    throw new Error("dispatch.message is required");
  }
  if (!dispatch.sessionKey || dispatch.sessionKey.trim().length === 0) {
    throw new Error("dispatch.sessionKey is required");
  }
  if (!dispatch.idempotencyKey || dispatch.idempotencyKey.trim().length === 0) {
    throw new Error("dispatch.idempotencyKey is required");
  }

  return {
    message: dispatch.message,
    sessionKey: dispatch.sessionKey,
    idempotencyKey: dispatch.idempotencyKey,
  };
}
