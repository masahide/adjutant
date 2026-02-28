import { join } from "node:path";
import { shiftDateKey } from "./shared-normalizers.js";

type DateKeys = {
  today: string;
  yesterday: string;
};

type ResolveMemoryPathsOptions = {
  workspaceDir: string;
  timezone: string;
  now?: Date;
};

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timezone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timezone);
  if (cached) {
    return cached;
  }
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  formatterCache.set(timezone, formatter);
  return formatter;
}

export function formatDateKeyInTimezone(date: Date, timezone: string): string {
  try {
    const formatter = getFormatter(timezone);
    const parts = formatter.formatToParts(date);
    const year = parts.find((part) => part.type === "year")?.value ?? "1970";
    const month = parts.find((part) => part.type === "month")?.value ?? "01";
    const day = parts.find((part) => part.type === "day")?.value ?? "01";
    return `${year}-${month}-${day}`;
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

export function resolveMemoryDateKeys(timezone: string, now: Date = new Date()): DateKeys {
  const today = formatDateKeyInTimezone(now, timezone);
  const yesterday = shiftDateKey(today, -1);
  return { today, yesterday };
}

export function resolveMemoryPaths(opts: ResolveMemoryPathsOptions): {
  longTermPath: string;
  dailyDir: string;
  dailyPath: string;
  yesterdayPath: string;
  todayKey: string;
  yesterdayKey: string;
} {
  const { today, yesterday } = resolveMemoryDateKeys(opts.timezone, opts.now);
  const dailyDir = join(opts.workspaceDir, "memory");
  return {
    longTermPath: join(opts.workspaceDir, "MEMORY.md"),
    dailyDir,
    dailyPath: join(dailyDir, `${today}.md`),
    yesterdayPath: join(dailyDir, `${yesterday}.md`),
    todayKey: today,
    yesterdayKey: yesterday,
  };
}
