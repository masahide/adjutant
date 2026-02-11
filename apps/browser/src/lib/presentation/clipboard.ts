import Handlebars from "handlebars";
import type { TemplateDelegate } from "handlebars";
import type { TimelineEvent } from "$lib/server/types";
import {
  classifyEventKind,
  getEventChannelLabel,
  getEventPresentation,
  getReactionEmoji,
} from "$lib/presentation/event";
import { formatEventTimestampJstIso } from "$lib/format/date";
import templateSource from "./templates/clipboardPrompt.hbs?raw";

const handlebars = Handlebars.create();

handlebars.registerHelper("join", (items: unknown, separator: unknown) => {
  if (!Array.isArray(items)) {
    return "";
  }
  const separatorValue = typeof separator === "string" ? separator : ", ";
  const normalized = items
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter((value) => value.length > 0);
  return normalized.join(separatorValue);
});

interface ClipboardTemplateEvent {
  timestamp: string;
  title: string;
  reactionLabel: string | null;
  actor: string | undefined;
  body: string | null;
}

interface ClipboardTemplateContext {
  date: string;
  hasSummary: boolean;
  summary: string | null;
  hasEvents: boolean;
  events: ClipboardTemplateEvent[];
}

const defaultTemplateSource = templateSource.trim();
const compiledTemplates = new Map<string, TemplateDelegate<ClipboardTemplateContext>>();

function getRenderer(source: string): TemplateDelegate<ClipboardTemplateContext> {
  const key = source.trim();
  const cached = compiledTemplates.get(key);
  if (cached) {
    return cached;
  }
  const renderer = handlebars.compile<ClipboardTemplateContext>(key);
  compiledTemplates.set(key, renderer);
  return renderer;
}

export const defaultClipboardTemplateSource = defaultTemplateSource;

export function buildClipboardPayload(
  date: string,
  events: TimelineEvent[],
  summary?: string | null,
  template?: string
): string {
  const normalizedSummary = summary?.trim() ?? null;
  const templateEvents = events.map((event) => buildTemplateEvent(event, date));
  const renderer = getRenderer(template ?? defaultTemplateSource);

  return renderer({
    date,
    summary: normalizedSummary,
    hasSummary: !!normalizedSummary,
    events: templateEvents,
    hasEvents: templateEvents.length > 0,
  }).trim();
}

function buildTemplateEvent(event: TimelineEvent, date: string): ClipboardTemplateEvent {
  const presentation = getEventPresentation(event);
  const channel = getEventChannelLabel(event);
  const actor = readString(event.raw as Record<string, unknown>, "actor");
  const subject = readString(event.raw as Record<string, unknown>, "subject") ?? event.uid;
  const kind = classifyEventKind(event);
  const reactionEmoji = kind === "reaction" ? getReactionEmoji(event) : null;
  const reactionLabel = normalizeReactionLabel(reactionEmoji);
  const sourceLabel = formatSourceLabel(event.source);
  const timestamp = formatEventTimestampJstIso(event.ts, date);

  const { remainder: subjectRemainder, channel: subjectChannel } = splitSubject(subject);
  const primaryChannel = channel ?? subjectChannel ?? null;

  const titleParts: string[] = [];
  if (sourceLabel) {
    titleParts.push(sourceLabel);
  }
  if (primaryChannel) {
    titleParts.push(primaryChannel);
  }

  let title: string;
  if (titleParts.length > 0) {
    title = titleParts.join(" ");
    if (subjectRemainder) {
      title += ` ${subjectRemainder}`;
    }
  } else {
    title = subject;
  }

  const text = presentation.text.trim();
  const body = text ? text.replace(/\r?\n/g, "\n  ") : null;

  return {
    timestamp,
    title,
    reactionLabel,
    actor,
    body,
  };
}

function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  if (!record) return undefined;
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function formatSourceLabel(source: string): string {
  const trimmed = source.trim();
  if (!trimmed) {
    return "";
  }

  const normalized = trimmed.toLowerCase();

  const known: Record<string, string> = {
    slack: "Slack",
    github: "GitHub",
    notion: "Notion",
    manual: "Manual",
  };

  const label = known[normalized];
  if (label) {
    return label;
  }

  return trimmed[0].toUpperCase() + trimmed.slice(1);
}

function splitSubject(subject: string): { channel: string | null; remainder: string } {
  const match = subject.match(/^\[(#[^\]]+)\]\s*(.*)$/);
  if (match) {
    const channel = match[1];
    const remainder = match[2] ?? "";
    return { channel, remainder: remainder.trim() };
  }
  return { channel: null, remainder: subject.trim() };
}

function normalizeReactionLabel(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const slugMatch = trimmed.match(/^:?([a-z0-9_\-+]+):?$/i);
  if (slugMatch) {
    return `:${slugMatch[1]}:`;
  }

  return trimmed;
}
