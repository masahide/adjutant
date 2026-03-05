import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { type HeartbeatRunResultV1, validateHeartbeatRunResultV1 } from "./schema.js";

type HeartbeatResultStoreOptions = {
  path: string;
  onWarn?: (message: string, meta?: Record<string, unknown>) => void;
};

export type HeartbeatHistoryPage = {
  items: HeartbeatRunResultV1[];
  nextCursor?: string;
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function parseLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return 20;
  }
  return Math.min(100, Math.max(1, Math.floor(value as number)));
}

function encodeCursor(offset: number): string {
  return Buffer.from(String(Math.max(0, Math.floor(offset))), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined) {
    return 0;
  }
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return 0;
    }
    return parsed;
  } catch {
    return 0;
  }
}

export class HeartbeatResultStore {
  private readonly path: string;
  private readonly onWarn: (message: string, meta?: Record<string, unknown>) => void;
  private readonly records: HeartbeatRunResultV1[] = [];

  constructor(options: HeartbeatResultStoreOptions) {
    this.path = options.path;
    this.onWarn = options.onWarn ?? (() => {});
  }

  static fromStateDir(
    stateDir: string,
    options?: {
      onWarn?: (message: string, meta?: Record<string, unknown>) => void;
    }
  ): HeartbeatResultStore {
    return new HeartbeatResultStore({
      path: join(stateDir, "heartbeat-runs.jsonl"),
      onWarn: options?.onWarn,
    });
  }

  pathForDebug(): string {
    return this.path;
  }

  async initialize(): Promise<void> {
    let raw = "";
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }
    const lines = raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    this.records.length = 0;
    for (let index = 0; index < lines.length; index += 1) {
      try {
        const parsed = JSON.parse(lines[index] ?? "{}") as unknown;
        if (!validateHeartbeatRunResultV1(parsed)) {
          this.onWarn("heartbeat.result.invalid_record", { line: index + 1 });
          continue;
        }
        this.records.push(parsed);
      } catch (error) {
        this.onWarn("heartbeat.result.parse_failed", {
          line: index + 1,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  getLast(): HeartbeatRunResultV1 | null {
    const record = this.records[this.records.length - 1];
    return record === undefined ? null : clone(record);
  }

  list(input?: { limit?: number; cursor?: string }): HeartbeatHistoryPage {
    const limit = parseLimit(input?.limit);
    const consumed = decodeCursor(input?.cursor);
    const total = this.records.length;
    const end = Math.max(0, total - consumed);
    const start = Math.max(0, end - limit);
    const slice = this.records
      .slice(start, end)
      .reverse()
      .map((record) => clone(record));
    const nextConsumed = consumed + slice.length;
    return {
      items: slice,
      nextCursor: start > 0 ? encodeCursor(nextConsumed) : undefined,
    };
  }

  async append(result: HeartbeatRunResultV1): Promise<void> {
    if (!validateHeartbeatRunResultV1(result)) {
      throw new Error("INVALID_REQUEST: invalid heartbeat result schema");
    }
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(result)}\n`, "utf8");
    this.records.push(clone(result));
  }
}
