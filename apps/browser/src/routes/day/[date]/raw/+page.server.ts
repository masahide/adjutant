import { error } from "@sveltejs/kit";
import { promises as fs } from "node:fs";
import { join } from "node:path";

import { resolveDataDir } from "$lib/server/config";
import type { RawPageData, RawFileEntry } from "$lib/viewModels/raw";

import type { PageServerLoad } from "./$types";
type ErrnoException = NodeJS.ErrnoException;

export const load: PageServerLoad = async (event) => {
  event.depends?.("reaclog:day:raw");

  const date = event.params.date;
  if (!date) {
    throw error(404, "date required");
  }

  const dataDir = resolveDataDir();
  const { year, month, day } = splitDate(date);
  const dayRoot = join(dataDir, year, month, day);

  const files = await collectRawFiles(dayRoot);
  if (files.length === 0) {
    throw error(404, "no raw data");
  }

  const sources = files.map((file) => file.source).sort();

  return {
    date,
    sources,
    files,
  } satisfies RawPageData;
};

async function collectRawFiles(dayRoot: string): Promise<RawFileEntry[]> {
  const entries = await safeReaddir(dayRoot);
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name !== "summaries")
      .map(async (entry) => {
        const filePath = join(dayRoot, entry.name, "events.jsonl");
        const lines = await readLines(filePath);
        return { source: entry.name, path: filePath, lines } satisfies RawFileEntry;
      })
  );

  return files
    .filter((file) => file.lines.length > 0)
    .sort((a, b) => a.source.localeCompare(b.source));
}

async function readLines(filePath: string): Promise<string[]> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return content
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (err) {
    if (isNotFoundError(err)) {
      return [];
    }
    throw err;
  }
}

async function safeReaddir(path: string) {
  try {
    return await fs.readdir(path, { withFileTypes: true });
  } catch (err) {
    if (isNotFoundError(err)) {
      return [];
    }
    throw err;
  }
}

function splitDate(date: string): { year: string; month: string; day: string } {
  const [year, month, day] = date.split("-");
  return { year, month, day };
}

function isNotFoundError(error: unknown): error is ErrnoException {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as ErrnoException).code === "ENOENT"
  );
}
