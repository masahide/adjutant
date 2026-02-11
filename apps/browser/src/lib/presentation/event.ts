import type { TimelineEvent } from "$lib/server/types";
import { renderMessageMarkdown, renderBlocksMarkdown } from "$lib/markdown";

export interface EventPresentation {
  text: string;
  html: string;
}

export type EventKind = "post" | "reaction" | "other";

export function getEventPresentation(event: TimelineEvent): EventPresentation {
  const message = sanitizeMessage(extractMessage(event) ?? event.uid);
  return {
    text: message,
    html: renderMessageMarkdown(message),
  };
}

export function classifyEventKind(event: TimelineEvent): EventKind {
  const raw = event.raw as Record<string, unknown>;
  const kind = typeof raw.kind === "string" ? raw.kind : null;
  if (kind === "reaction") {
    return "reaction";
  }
  if (kind === "post") {
    return "post";
  }
  return "other";
}

function extractMessage(event: TimelineEvent): string | null {
  const detail = readDetail(event);
  if (detail) {
    const scoped = detail[event.source] as Record<string, unknown> | undefined;
    if (scoped) {
      const text = readString(scoped, "text");
      if (text) {
        return text;
      }

      const messageText = readString(scoped, "message_text");
      if (messageText) {
        return messageText;
      }

      const blocks = readBlocks(scoped, "blocks");
      if (blocks) {
        return renderBlocksMarkdown(blocks);
      }

      const title = readString(scoped, "title");
      if (title) {
        return title;
      }
    }
  }

  const raw = event.raw as Record<string, unknown>;
  if (typeof raw.subject === "string" && raw.subject.trim().length > 0) {
    return raw.subject;
  }

  if (detail) {
    const scoped = detail[event.source] as Record<string, unknown> | undefined;
    if (scoped) {
      const title = readString(scoped, "title");
      if (title) {
        return title;
      }
    }
  }

  return null;
}

function readDetail(event: TimelineEvent): Record<string, unknown> | undefined {
  const raw = event.raw as Record<string, unknown>;
  return raw.detail as Record<string, unknown> | undefined;
}

function sanitizeMessage(message: string): string {
  const lines = message.split("\n");
  while (lines.length > 0 && isReactionCountLine(lines[lines.length - 1])) {
    lines.pop();
  }
  return lines.join("\n");
}

function isReactionCountLine(line: string): boolean {
  return /^\d+$/.test(line.trim());
}

function readBlocks(scope: Record<string, unknown>, key: string): unknown[] | null {
  const value = scope[key];
  if (!value) {
    return null;
  }
  if (Array.isArray(value)) {
    return value as unknown[];
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function getEventChannelLabel(event: TimelineEvent): string | null {
  const raw = event.raw as Record<string, unknown>;
  const meta = raw.meta as Record<string, unknown> | undefined;
  if (meta) {
    const channel = readString(meta, "channel") ?? readString(meta, "channel_name");
    if (channel) {
      return ensureChannelPrefix(channel);
    }
  }

  const detail = readDetail(event);
  if (detail) {
    const scoped = detail[event.source] as Record<string, unknown> | undefined;
    if (scoped) {
      const channelName = readString(scoped, "channel_name") ?? readString(scoped, "channel");
      if (channelName) {
        return ensureChannelPrefix(channelName);
      }
      const channelId = readString(scoped, "channel_id");
      if (channelId) {
        return ensureChannelPrefix(channelId);
      }
    }
  }

  return null;
}

function ensureChannelPrefix(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return trimmed;
  }
  return trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
}

export function getReactionEmoji(event: TimelineEvent): string | null {
  if (classifyEventKind(event) !== "reaction") {
    return null;
  }
  const raw = event.raw as Record<string, unknown>;
  const meta = raw.meta as Record<string, unknown> | undefined;
  if (meta) {
    const metaEmoji = readString(meta, "emoji");
    if (metaEmoji) {
      return metaEmoji;
    }
  }
  const detail = readDetail(event);
  if (detail) {
    const scoped = detail[event.source] as Record<string, unknown> | undefined;
    if (scoped) {
      const detailEmoji = readString(scoped, "emoji");
      if (detailEmoji) {
        return detailEmoji;
      }
    }
  }
  return null;
}

function readString(scope: Record<string, unknown>, key: string): string | null {
  const value = scope[key];
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  return null;
}
