import { promises as fs } from "node:fs";
import { watch as watchFile, type FSWatcher } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

export type JsonlFixture = {
  append: (record: Record<string, unknown>) => Promise<void>;
  watch: (callback: (record: Record<string, unknown>) => void) => () => void;
  readAll: () => Promise<Array<Record<string, unknown>>>;
  cleanup: () => Promise<void>;
  dataDir: string;
  filePath: string;
  dayDir: string;
  sourceDir: string;
  date: string;
};

type CreateFixtureOptions = {
  source: string;
  date?: string; // yyyy-mm-dd
};

const TMP_PREFIX = "reaclog-jsonl-fixture-";

export async function createJsonlFixture(options: CreateFixtureOptions): Promise<JsonlFixture> {
  const date = options.date ?? "2025-11-03";
  const [year, month, day] = date.split("-");

  const dataDir = await mkdtemp(join(tmpdir(), TMP_PREFIX));
  const dayDir = join(dataDir, year, month, day);
  const sourceDir = join(dayDir, options.source);
  const filePath = join(sourceDir, "events.jsonl");

  await fs.mkdir(sourceDir, { recursive: true });
  await ensureFile(filePath);

  const watchers = new Set<FSWatcher>();
  const triggers = new Set<() => void>();

  async function readAll(): Promise<Array<Record<string, unknown>>> {
    try {
      const content = await fs.readFile(filePath, "utf-8");
      return content
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line) as Record<string, unknown>;
          } catch {
            return {};
          }
        });
    } catch {
      return [];
    }
  }

  async function append(record: Record<string, unknown>): Promise<void> {
    const payload = `${JSON.stringify(record)}\n`;
    await fs.appendFile(filePath, payload, "utf-8");
    for (const trigger of triggers) {
      trigger();
    }
  }

  function watch(callback: (record: Record<string, unknown>) => void): () => void {
    let consumed = 0;
    let pending = false;
    let scheduled = false;
    let disposed = false;
    let deliveredOnce = false;

    async function flush() {
      if (disposed) {
        return;
      }
      if (pending) {
        scheduled = true;
        return;
      }
      pending = true;
      try {
        const records = await readAll();
        const start = deliveredOnce ? consumed : 0;
        const fresh = records.slice(start);
        consumed = records.length;
        deliveredOnce = true;
        fresh.forEach((record) => {
          callback(record);
        });
      } finally {
        pending = false;
        if (scheduled) {
          scheduled = false;
          void flush();
        }
      }
    }

    void (async () => {
      const records = await readAll();
      consumed = records.length;
    })();

    const trigger = () => {
      void flush();
    };

    const watcher = watchFile(filePath, { persistent: false }, (eventType) => {
      if (eventType === "change") {
        trigger();
      }
    });

    watchers.add(watcher);
    triggers.add(trigger);

    return () => {
      disposed = true;
      watcher.close();
      watchers.delete(watcher);
      triggers.delete(trigger);
    };
  }

  async function cleanup() {
    for (const watcher of watchers) {
      watcher.close();
    }
    watchers.clear();
    triggers.clear();
    await fs.rm(dataDir, { recursive: true, force: true });
  }

  return {
    append,
    watch,
    readAll,
    cleanup,
    dataDir,
    filePath,
    dayDir,
    sourceDir,
    date,
  };
}

export async function waitForExpect(
  assertion: () => void,
  timeoutMs = 500,
  intervalMs = 25
): Promise<void> {
  const start = Date.now();
  while (true) {
    try {
      assertion();
      return;
    } catch {
      if (Date.now() - start >= timeoutMs) {
        assertion();
        return;
      }
      await delay(intervalMs);
    }
  }
}

async function ensureFile(filePath: string): Promise<void> {
  await fs.mkdir(dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, "", { flag: "w" });
}

export async function writeDailySummary(options: {
  dataDir: string;
  date: string;
  content: string;
}): Promise<void> {
  const [year, month, day] = options.date.split("-");
  const summaryDir = join(options.dataDir, year, month, day, "summaries");
  await fs.mkdir(summaryDir, { recursive: true });
  await fs.writeFile(join(summaryDir, "daily.md"), options.content, "utf-8");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
