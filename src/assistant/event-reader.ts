import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { NormalizedEvent } from "../core/events.js";
import { isNormalizedEvent } from "../core/validateEvent.js";

export type ReadEventsOptions = {
  dataDir: string;
  date?: string;
  kinds?: string[];
  channels?: string[];
  sinceMinutes?: number;
  limit?: number;
};

const DEFAULT_SINCE_MINUTES = 60;
const DEFAULT_LIMIT = 200;

function resolveDateKey(value?: string): string {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }
  return new Date().toISOString().slice(0, 10);
}

function resolveEventsPath(dataDir: string, date: string): string {
  const [year = "1970", month = "01", day = "01"] = date.split("-");
  return join(dataDir, year, month, day, "slack", "events.jsonl");
}

function normalizeLimit(limit?: number): number {
  if (!Number.isFinite(limit)) {
    return DEFAULT_LIMIT;
  }
  return Math.max(0, Math.floor(limit as number));
}

function normalizeSinceMinutes(sinceMinutes?: number): number {
  if (!Number.isFinite(sinceMinutes)) {
    return DEFAULT_SINCE_MINUTES;
  }
  return Math.max(0, Math.floor(sinceMinutes as number));
}

function parseEventTs(event: NormalizedEvent): number {
  const fromTs = Date.parse(event.ts);
  if (Number.isFinite(fromTs)) {
    return fromTs;
  }
  const fromLoggedAt =
    typeof event.logged_at === "string" ? Date.parse(event.logged_at) : Number.NaN;
  if (Number.isFinite(fromLoggedAt)) {
    return fromLoggedAt;
  }
  return Number.NEGATIVE_INFINITY;
}

function extractChannelId(event: NormalizedEvent): string | null {
  const slack = (event.detail as { slack?: unknown } | undefined)?.slack;
  if (!slack || typeof slack !== "object") {
    return null;
  }
  const channelId = (slack as Record<string, unknown>).channel_id;
  if (typeof channelId !== "string") {
    return null;
  }
  const trimmed = channelId.trim();
  return trimmed ? trimmed : null;
}

function normalizeFilter(values?: string[]): Set<string> | null {
  if (!Array.isArray(values) || values.length === 0) {
    return null;
  }
  const normalized = values.map((value) => value.trim()).filter(Boolean);
  if (normalized.length === 0) {
    return null;
  }
  return new Set(normalized);
}

export async function readEvents(opts: ReadEventsOptions): Promise<NormalizedEvent[]> {
  const dateKey = resolveDateKey(opts.date);
  const eventsPath = resolveEventsPath(opts.dataDir, dateKey);
  const limit = normalizeLimit(opts.limit);
  if (limit === 0) {
    return [];
  }

  let raw: string;
  try {
    raw = await readFile(eventsPath, "utf8");
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const kindsFilter = normalizeFilter(opts.kinds);
  const channelsFilter = normalizeFilter(opts.channels);
  const sinceThreshold = Date.now() - normalizeSinceMinutes(opts.sinceMinutes) * 60_000;

  const parsed: NormalizedEvent[] = [];
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    try {
      const candidate = JSON.parse(line);
      if (!isNormalizedEvent(candidate)) {
        continue;
      }

      const eventTs = parseEventTs(candidate);
      if (eventTs < sinceThreshold) {
        continue;
      }
      if (kindsFilter && !kindsFilter.has(candidate.kind)) {
        continue;
      }
      if (channelsFilter) {
        const channelId = extractChannelId(candidate);
        if (!channelId || !channelsFilter.has(channelId)) {
          continue;
        }
      }
      parsed.push(candidate);
    } catch {
      // JSONL 破損行はスキップする
    }
  }

  parsed.sort((a, b) => parseEventTs(b) - parseEventTs(a));
  return parsed.slice(0, limit);
}
