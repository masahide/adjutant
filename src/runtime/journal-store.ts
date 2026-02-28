import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface Cursor {
  segment: number;
  offset: number;
}

export interface JournalRecord<T> {
  cursor: Cursor;
  value: T;
}

const DEFAULT_SEGMENT = 0;

function splitJsonLines(raw: string): string[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export class JournalStore<T> {
  constructor(private readonly filePath: string) {}

  async append(value: T): Promise<Cursor> {
    await mkdir(dirname(this.filePath), { recursive: true });

    const lines = await this.readLines();
    const cursor: Cursor = {
      segment: DEFAULT_SEGMENT,
      offset: lines.length,
    };

    await appendFile(this.filePath, `${JSON.stringify(value)}\n`, "utf8");
    return cursor;
  }

  async drain(cursor: Cursor, limit = Number.POSITIVE_INFINITY): Promise<JournalRecord<T>[]> {
    if (cursor.segment !== DEFAULT_SEGMENT) {
      return [];
    }

    const lines = await this.readLines();
    const start = Math.max(0, cursor.offset);
    const end = Number.isFinite(limit) ? Math.min(lines.length, start + limit) : lines.length;
    const result: JournalRecord<T>[] = [];

    for (let i = start; i < end; i += 1) {
      const line = lines[i];
      try {
        result.push({
          cursor: { segment: DEFAULT_SEGMENT, offset: i },
          value: JSON.parse(line) as T,
        });
      } catch {
        // invalid record is skipped by design; caller can report INVALID_RECORD.
      }
    }

    return result;
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
