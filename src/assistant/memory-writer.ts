import { appendFile, mkdir, stat, writeFile } from "node:fs/promises";
import { resolveMemoryPaths } from "./memory-paths.js";

export type MemoryWriteOptions = {
  workspaceDir: string;
  timezone: string;
  now?: Date;
};

async function hasExistingContent(filePath: string): Promise<boolean> {
  try {
    const info = await stat(filePath);
    return info.size > 0;
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function appendDailyMemory(content: string, opts: MemoryWriteOptions): Promise<void> {
  const text = content.trim();
  if (!text) {
    return;
  }

  const paths = resolveMemoryPaths(opts);
  await mkdir(paths.dailyDir, { recursive: true });

  const prefix = (await hasExistingContent(paths.dailyPath)) ? "\n" : "";
  await appendFile(paths.dailyPath, `${prefix}${text}\n`, "utf8");
}

export async function updateLongTermMemory(
  content: string,
  opts: MemoryWriteOptions
): Promise<void> {
  await mkdir(opts.workspaceDir, { recursive: true });
  const paths = resolveMemoryPaths(opts);
  await writeFile(paths.longTermPath, content, "utf8");
}
