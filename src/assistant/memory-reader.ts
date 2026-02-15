import { readFile } from "node:fs/promises";
import { resolveMemoryPaths } from "./memory-paths.js";

export type MemoryReadOptions = {
  workspaceDir: string;
  timezone: string;
  now?: Date;
};

export type MemoryReadResult = {
  longTerm: string | null;
  daily: string | null;
  yesterday: string | null;
};

async function readOptionalFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function readMemoryFiles(opts: MemoryReadOptions): Promise<MemoryReadResult> {
  const paths = resolveMemoryPaths(opts);
  const [longTerm, daily, yesterday] = await Promise.all([
    readOptionalFile(paths.longTermPath),
    readOptionalFile(paths.dailyPath),
    readOptionalFile(paths.yesterdayPath),
  ]);

  return { longTerm, daily, yesterday };
}
