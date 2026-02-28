import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

type RawFetchEvent = {
  source: string;
  kind: string;
  at: string;
  payload: unknown;
};

type RawFetchEventFileLoggerOptions = {
  filePath: string;
  now?: () => Date;
  maxPayloadChars?: number;
};

type RawFetchEventLogRecord = {
  schema: "adjutant.raw-fetch.event.v1";
  logged_at: string;
  source: string;
  kind: "raw_fetch";
  at: string;
  payload: unknown;
};

export class RawFetchEventFileLogger {
  private readonly filePath: string;
  private readonly now: () => Date;
  private readonly maxPayloadChars: number;
  private readonly ensureDirPromise: Promise<string | undefined>;
  private writeQueue: Promise<void> = Promise.resolve();
  private writeErrorCount = 0;

  constructor(options: RawFetchEventFileLoggerOptions) {
    this.filePath = options.filePath;
    this.now = options.now ?? (() => new Date());
    this.maxPayloadChars = Math.max(0, options.maxPayloadChars ?? 0);
    this.ensureDirPromise = mkdir(dirname(this.filePath), { recursive: true });
  }

  record(event: RawFetchEvent): void {
    if (event.kind !== "raw_fetch") return;
    const record: RawFetchEventLogRecord = {
      schema: "adjutant.raw-fetch.event.v1",
      logged_at: this.now().toISOString(),
      source: event.source,
      kind: "raw_fetch",
      at: event.at,
      payload: this.normalizePayload(event.payload),
    };
    const line = this.stringifyRecord(record);
    if (!line) return;

    this.writeQueue = this.writeQueue
      .then(async () => {
        await this.ensureDirPromise;
        await appendFile(this.filePath, line, "utf8");
      })
      .catch((err) => {
        this.writeErrorCount += 1;
        if (this.writeErrorCount <= 3) {
          console.error("[Adjutant] failed to append raw_fetch event log:", err);
        }
      });
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  private normalizePayload(payload: unknown): unknown {
    if (this.maxPayloadChars <= 0) {
      return payload;
    }

    let serialized: string;
    try {
      serialized = JSON.stringify(payload);
    } catch {
      return { _truncated: true, reason: "failed_to_stringify" };
    }

    if (serialized.length <= this.maxPayloadChars) {
      return payload;
    }

    return {
      _truncated: true,
      original_length: serialized.length,
      preview: serialized.slice(0, this.maxPayloadChars),
    };
  }

  private stringifyRecord(record: RawFetchEventLogRecord): string | null {
    try {
      return `${JSON.stringify(record)}\n`;
    } catch {
      return null;
    }
  }
}
