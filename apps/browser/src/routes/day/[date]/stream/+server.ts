import { promises as fs } from "node:fs";
import type { Dirent } from "node:fs";
import { join } from "node:path";

import { resolveDataDir } from "$lib/server/config";
import { normalizeEvent, readJsonlFile } from "$lib/server/data";
import type { TimelineEvent } from "$lib/server/types";

import type { RequestHandler } from "./$types";

const eventStreamHeaders = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache",
  connection: "keep-alive",
};

const encoder = new TextEncoder();

export const GET: RequestHandler = async ({ params, request }) => {
  const date = params.date;
  if (!date) {
    return new Response("missing date", { status: 400 });
  }

  const dataDir = resolveDataDir();
  let cleanup: () => void = () => {};
  let closed = false;

  const closeStream = () => {
    if (closed) {
      return;
    }
    closed = true;
    cleanup();
    cleanup = () => {};
  };

  const stream = new ReadableStream({
    start: async (controller) => {
      const enqueue = (chunk: string) => {
        if (closed) {
          return;
        }
        controller.enqueue(encoder.encode(chunk));
      };

      cleanup = await registerWatchers({
        dataDir,
        date,
        onEvent: (event) => {
          enqueue(formatEvent(event));
        },
        onError: (error) => {
          enqueue(`event: error\ndata: ${JSON.stringify(error.message)}\n\n`);
        },
      });

      enqueue(`event: ready\ndata: {"date":"${date}"}\n\n`);

      const abort = () => {
        if (closed) {
          return;
        }
        closeStream();
        controller.close();
      };

      if (request.signal.aborted) {
        abort();
      } else {
        request.signal.addEventListener("abort", abort, { once: true });
      }
    },
    cancel: async () => {
      closeStream();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: eventStreamHeaders,
  });
};

type RegisterOptions = {
  dataDir: string;
  date: string;
  onEvent: (event: TimelineEvent) => void;
  onError: (error: Error) => void;
};

async function registerWatchers(options: RegisterOptions): Promise<() => void> {
  const { dataDir, date, onEvent, onError } = options;
  const dayDir = resolveDayDir(dataDir, date);
  const sourceWatchers = new Map<string, SourceWatcher>();

  let disposed = false;

  await fs.mkdir(dayDir, { recursive: true });

  async function ensureSourceWatcher(source: string, baseline = 0) {
    if (disposed) {
      return;
    }
    if (source === "summaries") {
      return;
    }
    if (sourceWatchers.has(source)) {
      return;
    }

    try {
      const watcher = await createSourceWatcher({
        dayDir,
        source,
        onEvent,
        initialCount: baseline,
      });
      sourceWatchers.set(source, watcher);
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  const initialEntries = await safeReaddir(dayDir);
  const initialCounts = await collectInitialCounts(dayDir, initialEntries);
  await Promise.all(
    initialEntries
      .filter((entry) => entry.isDirectory())
      .map((entry) => ensureSourceWatcher(entry.name, initialCounts.get(entry.name) ?? 0))
  );

  const discoveryTimer = setInterval(async () => {
    if (disposed) {
      return;
    }
    const entries = await safeReaddir(dayDir);
    const existing = new Set(
      entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    );
    await Promise.all(
      Array.from(existing)
        .filter((name) => !sourceWatchers.has(name) && name !== "summaries")
        .map((name) => ensureSourceWatcher(name, 0))
    );

    for (const [source, watcher] of sourceWatchers.entries()) {
      if (!existing.has(source)) {
        watcher.dispose();
        sourceWatchers.delete(source);
      }
    }
  }, 1000);

  return () => {
    if (disposed) {
      return;
    }
    disposed = true;
    clearInterval(discoveryTimer);
    for (const watcher of sourceWatchers.values()) {
      watcher.dispose();
    }
    sourceWatchers.clear();
  };
}

type SourceWatcher = {
  dispose: () => void;
};

type SourceWatcherOptions = {
  dayDir: string;
  source: string;
  onEvent: (event: TimelineEvent) => void;
  initialCount?: number;
};

async function createSourceWatcher(options: SourceWatcherOptions): Promise<SourceWatcher> {
  const { dayDir, source, onEvent, initialCount } = options;
  const sourceDir = join(dayDir, source);
  const jsonlPath = join(sourceDir, "events.jsonl");

  await fs.mkdir(sourceDir, { recursive: true });
  await touch(jsonlPath);

  let consumed =
    typeof initialCount === "number" ? initialCount : (await readJsonlFile(jsonlPath)).length;
  let disposed = false;
  let flushing = false;
  let queued = false;

  async function flush() {
    if (disposed) {
      return;
    }
    if (flushing) {
      queued = true;
      return;
    }
    flushing = true;

    try {
      const records = await readJsonlFile(jsonlPath);
      if (consumed > records.length) {
        consumed = 0;
      }
      const fresh = records.slice(consumed);
      consumed = records.length;
      fresh.forEach((raw) => {
        const event = normalizeEvent(raw, source);
        onEvent(event);
      });
    } finally {
      flushing = false;
      if (queued) {
        queued = false;
        void flush();
      }
    }
  }

  const timer = setInterval(() => {
    if (disposed) {
      return;
    }
    void flush();
  }, 500);

  return {
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      clearInterval(timer);
    },
  };
}

function formatEvent(event: TimelineEvent): string {
  return `event: timeline\ndata: ${JSON.stringify(event)}\n\n`;
}

async function safeReaddir(path: string) {
  try {
    return await fs.readdir(path, { withFileTypes: true });
  } catch (error) {
    if (isNotFoundError(error)) {
      return [];
    }
    throw error;
  }
}

function resolveDayDir(dataDir: string, date: string): string {
  const [year, month, day] = date.split("-");
  return join(dataDir, year, month, day);
}

function isNotFoundError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

async function touch(filePath: string): Promise<void> {
  try {
    const handle = await fs.open(filePath, "a");
    await handle.close();
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }
}

async function collectInitialCounts(
  dayDir: string,
  entries: Dirent[]
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name !== "summaries")
      .map(async (entry) => {
        const jsonlPath = join(dayDir, entry.name, "events.jsonl");
        const count = await countRecords(jsonlPath);
        result.set(entry.name, count);
      })
  );
  return result;
}

async function countRecords(jsonlPath: string): Promise<number> {
  const records = await readJsonlFile(jsonlPath);
  return records.length;
}
