import type { NormalizedEvent } from "../core/events.js";
import type { SessionTranscriptEvent } from "./types.js";
import { extractTranscriptMessageText, normalizeTranscriptRole } from "./transcript-utils.js";

export type ContextBuildOptions = {
  events: NormalizedEvent[];
  systemEvents?: string[];
  recentTranscript?: SessionTranscriptEvent[];
  memoryContent?: string;
  dailyMemoryContent?: string;
  yesterdayMemoryContent?: string;
  maxTokenEstimate?: number;
};

export type ContextBuildResult = {
  text: string;
  truncated: boolean;
  eventCount: number;
};

const DEFAULT_MAX_TOKEN_ESTIMATE = 8000;

function cleanText(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const cleaned = value.trim();
  return cleaned ? cleaned : null;
}

function estimateMaxChars(maxTokenEstimate?: number): number {
  const tokenEstimate = Number.isFinite(maxTokenEstimate)
    ? Math.max(1, Math.floor(maxTokenEstimate as number))
    : DEFAULT_MAX_TOKEN_ESTIMATE;
  return tokenEstimate * 4;
}

function extractSlackDetail(event: NormalizedEvent): { channelId?: string; text?: string } {
  const slack = (event.detail as { slack?: unknown } | undefined)?.slack;
  if (!slack || typeof slack !== "object") {
    return {};
  }
  const record = slack as Record<string, unknown>;
  const channelId = typeof record.channel_id === "string" ? record.channel_id : undefined;
  const text = typeof record.text === "string" ? record.text : undefined;
  return { channelId, text };
}

function renderEvents(events: NormalizedEvent[]): string | null {
  if (events.length === 0) {
    return null;
  }

  const lines = events.map((event) => {
    const { channelId, text } = extractSlackDetail(event);
    const ts = event.ts;
    const role = event.actor ? `${event.actor}` : "unknown";
    const channel = channelId ? ` channel=${channelId}` : "";
    const detail = cleanText(text) ?? cleanText(event.subject) ?? "(no text)";
    return `- [${ts}] ${event.source}/${event.kind}${channel} by ${role}: ${detail}`;
  });

  return `## Recent Slack Events\n${lines.join("\n")}`;
}

function renderSystemEvents(systemEvents: string[] | undefined): string | null {
  if (!systemEvents || systemEvents.length === 0) {
    return null;
  }
  const cleaned = systemEvents.map((event) => event.trim()).filter(Boolean);
  if (cleaned.length === 0) {
    return null;
  }
  return `## System Events\n${cleaned.map((event) => `- ${event}`).join("\n")}`;
}

function renderRecentTranscript(
  recentTranscript: SessionTranscriptEvent[] | undefined
): string | null {
  if (!recentTranscript || recentTranscript.length === 0) {
    return null;
  }

  const lines = recentTranscript
    .map((event) => {
      const role = normalizeTranscriptRole(event.role);
      const textFromRaw =
        event.raw.message && typeof event.raw.message === "object"
          ? extractTranscriptMessageText(event.raw.message as Record<string, unknown>)
          : undefined;
      const text = cleanText(event.text) ?? cleanText(textFromRaw) ?? "(no text)";
      return `- [${new Date(event.ts).toISOString()}] ${role}: ${text}`;
    })
    .filter(Boolean);
  if (lines.length === 0) {
    return null;
  }

  return `## Recent Session Transcript\n${lines.join("\n")}`;
}

function renderMemorySection(title: string, content?: string): string | null {
  const cleaned = cleanText(content);
  if (!cleaned) {
    return null;
  }
  return `## ${title}\n${cleaned}`;
}

function truncateContext(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }

  const notice = "[context truncated]\n";
  if (maxChars <= notice.length) {
    return {
      text: text.slice(text.length - maxChars),
      truncated: true,
    };
  }

  const keep = maxChars - notice.length;
  return {
    text: `${notice}${text.slice(text.length - keep)}`,
    truncated: true,
  };
}

export function buildEventContext(opts: ContextBuildOptions): ContextBuildResult {
  const sections: string[] = [];

  const renderedSystemEvents = renderSystemEvents(opts.systemEvents);
  if (renderedSystemEvents) {
    sections.push(renderedSystemEvents);
  }

  const renderedEvents = renderEvents(opts.events);
  if (renderedEvents) {
    sections.push(renderedEvents);
  }

  const renderedTranscript = renderRecentTranscript(opts.recentTranscript);
  if (renderedTranscript) {
    sections.push(renderedTranscript);
  }

  const longTermMemory = renderMemorySection("Long-term Memory (MEMORY.md)", opts.memoryContent);
  if (longTermMemory) {
    sections.push(longTermMemory);
  }

  const dailyMemory = renderMemorySection("Daily Memory (Today)", opts.dailyMemoryContent);
  if (dailyMemory) {
    sections.push(dailyMemory);
  }

  const yesterdayMemory = renderMemorySection(
    "Daily Memory (Yesterday)",
    opts.yesterdayMemoryContent
  );
  if (yesterdayMemory) {
    sections.push(yesterdayMemory);
  }

  const raw = sections.join("\n\n");
  const maxChars = estimateMaxChars(opts.maxTokenEstimate);
  const { text, truncated } = truncateContext(raw, maxChars);

  return {
    text,
    truncated,
    eventCount: opts.events.length,
  };
}
