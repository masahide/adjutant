import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { Cursor } from "./journal-store.js";

export interface JournalCompactionResult {
  compacted: boolean;
  removedLines: number;
  remainingLines: number;
  nextCursor: Cursor;
}

function splitJsonLines(raw: string): string[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export class JournalCompactor {
  constructor(private readonly filePath: string) {}

  async compact(cursor: Cursor): Promise<JournalCompactionResult> {
    if (cursor.segment !== 0 || cursor.offset < 0) {
      return {
        compacted: false,
        removedLines: 0,
        remainingLines: await this.countLines(),
        nextCursor: cursor,
      };
    }

    const lines = await this.readLines();
    if (lines.length === 0) {
      return {
        compacted: false,
        removedLines: 0,
        remainingLines: 0,
        nextCursor: { segment: 0, offset: 0 },
      };
    }

    const removeCount = Math.min(lines.length, cursor.offset + 1);
    if (removeCount <= 0) {
      return {
        compacted: false,
        removedLines: 0,
        remainingLines: lines.length,
        nextCursor: cursor,
      };
    }

    const remaining = lines.slice(removeCount);
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, remaining.length > 0 ? `${remaining.join("\n")}\n` : "", "utf8");

    return {
      compacted: true,
      removedLines: removeCount,
      remainingLines: remaining.length,
      nextCursor: { segment: 0, offset: 0 },
    };
  }

  private async countLines(): Promise<number> {
    const lines = await this.readLines();
    return lines.length;
  }

  private async readLines(): Promise<string[]> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      return splitJsonLines(raw);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }
}
