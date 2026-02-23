import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { NormalizedEvent } from "../core/events.js";
import { normalizeAccountId, resolveEventJsonlPath } from "../runtime/data-paths.js";
import { withJsonlChecksum } from "./jsonl-checksum.js";

type JsonlWriterOptions = {
  dataDir: string;
  defaultAccountId?: string;
};

type ErrnoLike = { code?: string };

export class JsonlWriter {
  constructor(private readonly options: JsonlWriterOptions) {}

  async append(event: NormalizedEvent): Promise<void> {
    const { dataDir } = this.options;
    const normalized = this.ensureAccountId(this.ensureLoggedAt(event));
    const { dir, file } = this.resolvePaths(dataDir, normalized);
    await mkdir(dir, { recursive: true });
    const line = `${JSON.stringify(withJsonlChecksum(normalized as Record<string, unknown>))}\n`;
    await this.appendWithRetry(file, line);
  }

  private resolvePaths(baseDir: string, event: NormalizedEvent): { dir: string; file: string } {
    const dateKey = extractDateKey(event.logged_at ?? "");
    const meta = event.meta ?? {};
    const accountId = normalizeAccountId(
      typeof meta.account_id === "string" ? meta.account_id : undefined,
      this.options.defaultAccountId ?? "default"
    );
    return resolveEventJsonlPath({
      dataDir: baseDir,
      accountId,
      fallbackAccountId: this.options.defaultAccountId ?? "default",
      dateKey,
      source: event.source,
    });
  }

  private ensureLoggedAt(event: NormalizedEvent): NormalizedEvent {
    if (typeof event.logged_at === "string" && event.logged_at.trim() !== "") {
      return event;
    }
    const fallback = new Date().toISOString();
    event.logged_at = fallback;
    return event;
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
        await appendFile(file, content, "utf8");
        return;
      } catch (err) {
        lastError = err;
        if (i === attempts - 1) break;
        // ディレクトリが消えていた場合に備えて再作成
        if ((err as ErrnoLike)?.code === "ENOENT") {
          await mkdir(dirname(file), { recursive: true });
        }
      }
    }
    throw lastError;
  }
}

const extractDateKey = (value: string): string => {
  const iso = (() => {
    if (value && value.includes("T")) return value;
    const numeric = Number.parseFloat(value);
    if (Number.isFinite(numeric)) {
      return new Date(Math.round(numeric * 1000)).toISOString();
    }
    return new Date().toISOString();
  })();

  const datePart = iso.split("T")[0] ?? "1970-01-01";
  const [year = "1970", month = "01", day = "01"] = datePart.split("-");
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
};
