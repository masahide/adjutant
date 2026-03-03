import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { NormalizedEvent } from "../core/events.js";
import { withJsonlChecksum } from "./jsonl-checksum.js";

type ErrnoLike = { code?: string };

type FileOps = {
  appendFile: (path: string, content: string, encoding: "utf8") => Promise<void>;
  mkdir: (path: string, options: { recursive: true }) => Promise<unknown>;
};

const defaultFileOps: FileOps = {
  appendFile,
  mkdir,
};

export type JsonlWriterOptions = {
  dataDir: string;
  defaultAccountId?: string;
  now?: () => Date;
  fileOps?: FileOps;
};

export class JsonlWriter {
  private readonly now: () => Date;
  private readonly fileOps: FileOps;

  constructor(private readonly options: JsonlWriterOptions) {
    this.now = options.now ?? (() => new Date());
    this.fileOps = options.fileOps ?? defaultFileOps;
  }

  async append(event: NormalizedEvent): Promise<void> {
    const normalized = this.ensureAccountId(this.ensureLoggedAt(event));
    const { dir, file } = this.resolvePaths(normalized);
    await this.fileOps.mkdir(dir, { recursive: true });
    const line = `${JSON.stringify(withJsonlChecksum(normalized as Record<string, unknown>))}\n`;
    await this.appendWithRetry(file, line);
  }

  private resolvePaths(event: NormalizedEvent): { dir: string; file: string } {
    const dateKey = extractDateKey(event.logged_at ?? "", this.now);
    const [year = "1970", month = "01", day = "01"] = dateKey.split("-");
    const accountId = normalizeAccountId(
      typeof event.meta?.account_id === "string" ? event.meta.account_id : undefined,
      this.options.defaultAccountId ?? "default"
    );
    const dir = join(
      resolve(this.options.dataDir),
      "accounts",
      accountId,
      year,
      month.padStart(2, "0"),
      day.padStart(2, "0"),
      event.source
    );
    return {
      dir,
      file: join(dir, "events.jsonl"),
    };
  }

  private ensureLoggedAt(event: NormalizedEvent): NormalizedEvent {
    if (typeof event.logged_at === "string" && event.logged_at.trim() !== "") {
      return event;
    }
    return {
      ...event,
      logged_at: this.now().toISOString(),
    };
  }

  private ensureAccountId(event: NormalizedEvent): NormalizedEvent {
    const normalized = normalizeAccountId(
      typeof event.meta?.account_id === "string" ? event.meta.account_id : undefined,
      this.options.defaultAccountId ?? "default"
    );
    return {
      ...event,
      meta: {
        ...(event.meta ?? {}),
        account_id: normalized,
      },
    };
  }

  private async appendWithRetry(file: string, content: string, attempts = 2): Promise<void> {
    let lastError: unknown;
    for (let i = 0; i < attempts; i += 1) {
      try {
        await this.fileOps.appendFile(file, content, "utf8");
        return;
      } catch (error) {
        lastError = error;
        if (i === attempts - 1) {
          break;
        }
        if ((error as ErrnoLike)?.code === "ENOENT") {
          await this.fileOps.mkdir(dirname(file), { recursive: true });
        }
      }
    }
    throw lastError;
  }
}

function normalizeAccountId(value: string | undefined, fallback: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    return fallback;
  }
  const sanitized = normalized.replace(/[^A-Za-z0-9._-]+/g, "_");
  return sanitized || fallback;
}

function extractDateKey(value: string, now: () => Date): string {
  const iso = (() => {
    if (value && value.includes("T")) {
      return value;
    }
    const numeric = Number.parseFloat(value);
    if (Number.isFinite(numeric)) {
      return new Date(Math.round(numeric * 1000)).toISOString();
    }
    return now().toISOString();
  })();

  const datePart = iso.split("T")[0] ?? "1970-01-01";
  const [year = "1970", month = "01", day = "01"] = datePart.split("-");
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}
