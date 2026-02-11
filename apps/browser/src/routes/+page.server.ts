import { promises as fs } from "node:fs";
import { join } from "node:path";

import { readDailyEvents, readDailySummary } from "$lib/server/data";
import { resolveDataDir } from "$lib/server/config";
import type { DashboardDay, DashboardLoadData } from "$lib/viewModels/dashboard";

import type { PageServerLoad } from "./$types";
type ErrnoException = NodeJS.ErrnoException;

const MAX_DAYS = 7;

export const load: PageServerLoad = async (event) => {
  event.depends?.("reaclog:dashboard");
  const dataDir = resolveDataDir();
  const availableDates = await listAvailableDates(dataDir);
  const targetDates = availableDates.slice(0, MAX_DAYS);

  const days: DashboardDay[] = await Promise.all(
    targetDates.map(async (date) => {
      const [events, summary] = await Promise.all([
        readDailyEvents({ dataDir, date }),
        readDailySummary({ dataDir, date }),
      ]);

      const sources = Object.entries(events.bySource)
        .map(([source, count]) => ({ source, count }))
        .sort((a, b) => {
          if (b.count !== a.count) {
            return b.count - a.count;
          }
          return a.source.localeCompare(b.source);
        });

      return {
        date,
        total: events.events.length,
        sources,
        hasSummary: Boolean(summary),
        summaryPreview: summary ? summarizeMarkdown(summary) : null,
      };
    })
  );

  return {
    days,
    generatedAt: new Date().toISOString(),
  } satisfies DashboardLoadData;
};

async function listAvailableDates(dataDir: string): Promise<string[]> {
  const dates: string[] = [];
  const years = await safeReaddir(dataDir);

  for (const yearEntry of years) {
    if (!yearEntry.isDirectory() || !isYearSegment(yearEntry.name)) {
      continue;
    }
    const year = yearEntry.name;
    const yearPath = join(dataDir, year);
    const months = await safeReaddir(yearPath);

    for (const monthEntry of months) {
      if (!monthEntry.isDirectory() || !isMonthSegment(monthEntry.name)) {
        continue;
      }
      const month = monthEntry.name;
      const monthPath = join(yearPath, month);
      const days = await safeReaddir(monthPath);

      for (const dayEntry of days) {
        if (!dayEntry.isDirectory() || !isDaySegment(dayEntry.name)) {
          continue;
        }
        dates.push(`${year}-${month}-${dayEntry.name}`);
      }
    }
  }

  dates.sort((a, b) => b.localeCompare(a));
  return dates;
}

async function safeReaddir(path: string) {
  try {
    return await fs.readdir(path, { withFileTypes: true });
  } catch (error) {
    if (isNotFoundError(error)) {
      return [];
    }
    throw error;
  }
}

function isYearSegment(value: string) {
  return /^\d{4}$/.test(value);
}

function isMonthSegment(value: string) {
  return /^\d{2}$/.test(value) && Number(value) >= 1 && Number(value) <= 12;
}

function isDaySegment(value: string) {
  return /^\d{2}$/.test(value) && Number(value) >= 1 && Number(value) <= 31;
}

function summarizeMarkdown(markdown: string): string {
  const lines = markdown
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  return lines.slice(0, 3).join("\n");
}

function isNotFoundError(error: unknown): error is ErrnoException {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as ErrnoException).code === "ENOENT"
  );
}
