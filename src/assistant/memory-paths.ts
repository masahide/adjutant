import { join } from "node:path";

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
