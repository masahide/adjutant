import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { Cursor } from "./journal-store.js";

const DEFAULT_CURSOR: Cursor = { segment: 0, offset: 0 };

function isCursor(value: unknown): value is Cursor {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return typeof candidate.segment === "number" && typeof candidate.offset === "number";
}

export class CursorStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<Cursor> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      return isCursor(parsed) ? parsed : DEFAULT_CURSOR;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return DEFAULT_CURSOR;
      }
      throw error;
    }
  }

  async commit(cursor: Cursor): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });

    const tempPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(cursor)}\n`, "utf8");

    try {
      await rename(tempPath, this.filePath);
    } catch (error) {
      await rm(tempPath, { force: true });
      throw error;
    }
  }
}
