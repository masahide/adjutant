import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { NormalizedEvent } from "../core/events.js";
import { isNormalizedEvent } from "../core/validateEvent.js";
import { formatDateKeyInTimezone } from "./memory-paths.js";

export type ReadEventsOptions = {
  dataDir: string;
  date?: string;
  timezone?: string;
  kinds?: string[];
  channels?: string[];
  sinceMinutes?: number;
  limit?: number;
};

const DEFAULT_SINCE_MINUTES = 60;
const DEFAULT_LIMIT = 200;
const DEFAULT_TIMEZONE = process.env.ADJUTANT_TZ || "Asia/Tokyo";
const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DATE_KEY_WINDOW_LIMIT = 3660;

function resolveTimezone(value?: string): string {
  if (typeof value !== "string") {
    return DEFAULT_TIMEZONE;
  }
  const trimmed = value.trim();
  return trimmed || DEFAULT_TIMEZONE;
}

function resolveDateKey(value: string | undefined, timezone: string): string {
  if (typeof value === "string" && DATE_KEY_PATTERN.test(value)) {
    return value;
  }
  return formatDateKeyInTimezone(new Date(Date.now()), timezone);
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

function parseDayEndMsUtc(dateKey: string): number {
  const parsed = Date.parse(`${dateKey}T23:59:59.999Z`);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function shiftDateKey(dateKey: string, days: number): string {
  const [yearRaw = "1970", monthRaw = "01", dayRaw = "01"] = dateKey.split("-");
  const year = Number.parseInt(yearRaw, 10);
  const month = Number.parseInt(monthRaw, 10);
  const day = Number.parseInt(dayRaw, 10);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return "1970-01-01";
  }
  const base = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

function resolveDateKeysForWindow(params: {
  explicitDate: boolean;
  dateKey: string;
  sinceThreshold: number;
  timezone: string;
}): string[] {
  const { explicitDate, dateKey, sinceThreshold, timezone } = params;
  if (explicitDate) {
    return [dateKey];
  }

  const oldestKey = formatDateKeyInTimezone(new Date(sinceThreshold), timezone);
  const dateKeys = [dateKey];
  let cursor = dateKey;
  while (cursor !== oldestKey && dateKeys.length < DATE_KEY_WINDOW_LIMIT) {
    cursor = shiftDateKey(cursor, -1);
    dateKeys.push(cursor);
  }
  return dateKeys;
}

export async function readEvents(opts: ReadEventsOptions): Promise<NormalizedEvent[]> {
  const timezone = resolveTimezone(opts.timezone);
  const explicitDate = typeof opts.date === "string" && DATE_KEY_PATTERN.test(opts.date);
  const dateKey = resolveDateKey(opts.date, timezone);
  const limit = normalizeLimit(opts.limit);
  if (limit === 0) {
    return [];
  }

  const kindsFilter = normalizeFilter(opts.kinds);
  const channelsFilter = normalizeFilter(opts.channels);
  const now = Date.now();
  const referenceNow = explicitDate ? Math.min(now, parseDayEndMsUtc(dateKey)) : now;
  const sinceThreshold = referenceNow - normalizeSinceMinutes(opts.sinceMinutes) * 60_000;
  const dateKeys = resolveDateKeysForWindow({
    explicitDate,
    dateKey,
    sinceThreshold,
    timezone,
  });

  const raws: string[] = [];
  for (const targetDate of dateKeys) {
    const eventsPath = resolveEventsPath(opts.dataDir, targetDate);
    try {
      raws.push(await readFile(eventsPath, "utf8"));
    } catch (error) {
      const errno = error as NodeJS.ErrnoException;
      if (errno.code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }
  if (raws.length === 0) {
    return [];
  }

  const parsed: NormalizedEvent[] = [];
  for (const raw of raws) {
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
  }

  parsed.sort((a, b) => parseEventTs(b) - parseEventTs(a));
  if (parsed.length <= limit) {
    return parsed;
  }
  return parsed.slice(0, limit);
}
