import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { NormalizedEvent } from "../core/events.js";

type JsonlWriterOptions = {
  dataDir: string;
};

type ErrnoLike = { code?: string };

export class JsonlWriter {
  constructor(private readonly options: JsonlWriterOptions) {}

  async append(event: NormalizedEvent): Promise<void> {
    const { dataDir } = this.options;
    const normalized = this.ensureLoggedAt(event);
    const { dir, file } = this.resolvePaths(dataDir, normalized);
    await mkdir(dir, { recursive: true });
    const line = `${JSON.stringify(normalized)}\n`;
    await this.appendWithRetry(file, line);
  }

  private resolvePaths(baseDir: string, event: NormalizedEvent): { dir: string; file: string } {
    const [year, month, day] = extractDateParts(event.logged_at ?? "");
    const dir = join(baseDir, year, month, day, event.source);
    const file = join(dir, "events.jsonl");
    return { dir, file };
  }

  private ensureLoggedAt(event: NormalizedEvent): NormalizedEvent {
    if (typeof event.logged_at === "string" && event.logged_at.trim() !== "") {
      return event;
    }
    const fallback = new Date().toISOString();
    event.logged_at = fallback;
    return event;
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

const extractDateParts = (value: string): [string, string, string] => {
  const iso = (() => {
    if (value && value.includes("T")) return value;
    const numeric = Number.parseFloat(value);
    if (Number.isFinite(numeric)) {
      return new Date(Math.round(numeric * 1000)).toISOString();
    }
    return new Date().toISOString();
  })();

  const datePart = iso.split("T")[0] ?? "";
  const [year = "1970", month = "01", day = "01"] = datePart.split("-");
  return [year, month.padStart(2, "0"), day.padStart(2, "0")];
};
