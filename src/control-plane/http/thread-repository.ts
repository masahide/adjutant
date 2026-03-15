import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { CursorStore } from "../../runtime/cursor-store.js";
import { JournalStore } from "../../runtime/journal-store.js";
import type { ThreadRecord } from "../contracts/http-api.js";

const MAIN_THREAD_ID = "main";
const MAIN_VIRTUAL_TIMESTAMP = "1970-01-01T00:00:00.000Z";

type ThreadMemoryScope = "main" | "spoke";

type ThreadUpsertEntry = {
  op: "upsert";
} & ThreadRecord;

type ThreadDeleteEntry = {
  op: "delete";
  threadId: string;
  deletedAt: string;
};

type ThreadJournalEntry = ThreadUpsertEntry | ThreadDeleteEntry;

interface ThreadSnapshot {
  version: 1;
  threads: ThreadRecord[];
}

export interface ThreadRepositoryOptions {
  journalPath: string;
  replayCursorPath: string;
  snapshotPath: string;
  now?: () => string;
  newThreadId?: () => string;
  onWarn?: (message: string, meta?: Record<string, unknown>) => void;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createVirtualMainThread(): ThreadRecord {
  return {
    threadId: MAIN_THREAD_ID,
    title: "Main",
    archived: false,
    isDefault: true,
    createdAt: MAIN_VIRTUAL_TIMESTAMP,
    updatedAt: MAIN_VIRTUAL_TIMESTAMP,
  };
}

function defaultThreadId(): string {
  return `thr_${randomBytes(6).toString("hex")}`;
}

function parseSnapshot(raw: string): ThreadSnapshot | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isObject(parsed) || parsed.version !== 1 || !Array.isArray(parsed.threads)) {
      return null;
    }
    const threads = parsed.threads.filter(isThreadRecord);
    return {
      version: 1,
      threads,
    };
  } catch {
    return null;
  }
}

function isThreadRecord(value: unknown): value is ThreadRecord {
  return (
    isObject(value) &&
    typeof value.threadId === "string" &&
    typeof value.title === "string" &&
    typeof value.archived === "boolean" &&
    typeof value.isDefault === "boolean" &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
  );
}

function parseThreadJournalEntry(value: unknown): ThreadJournalEntry | null {
  if (!isObject(value) || typeof value.op !== "string") {
    return null;
  }
  if (value.op === "upsert") {
    if (!isThreadRecord(value)) {
      return null;
    }
    return {
      op: "upsert",
      threadId: value.threadId,
      title: value.title,
      archived: value.archived,
      isDefault: value.isDefault,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
    };
  }
  if (value.op === "delete") {
    if (typeof value.threadId !== "string" || typeof value.deletedAt !== "string") {
      return null;
    }
    return {
      op: "delete",
      threadId: value.threadId,
      deletedAt: value.deletedAt,
    };
  }
  return null;
}

export class ThreadRepository {
  private readonly byThreadId = new Map<string, ThreadRecord>();
  private readonly journal: JournalStore<ThreadJournalEntry>;
  private readonly journalPath: string;
  private readonly replayCursor: CursorStore;
  private readonly snapshotPath: string;
  private readonly now: () => string;
  private readonly newThreadId: () => string;
  private readonly onWarn: (message: string, meta?: Record<string, unknown>) => void;

  constructor(options: ThreadRepositoryOptions) {
    this.journalPath = options.journalPath;
    this.journal = new JournalStore(options.journalPath);
    this.replayCursor = new CursorStore(options.replayCursorPath);
    this.snapshotPath = options.snapshotPath;
    this.now = options.now ?? (() => new Date().toISOString());
    this.newThreadId = options.newThreadId ?? defaultThreadId;
    this.onWarn = options.onWarn ?? (() => {});
  }

  static fromStateDir(
    stateDir: string,
    options?: { onWarn?: (message: string, meta?: Record<string, unknown>) => void }
  ): ThreadRepository {
    return new ThreadRepository({
      journalPath: join(stateDir, "journal", "control-plane", "threads.jsonl"),
      replayCursorPath: join(stateDir, "cursor", "control-plane.threads.replay-cursor.json"),
      snapshotPath: join(stateDir, "cursor", "control-plane.threads.snapshot.json"),
      onWarn: options?.onWarn,
    });
  }

  async initialize(): Promise<void> {
    await this.loadSnapshot();

    const cursor = await this.replayCursor.load();
    const replayResult = await this.replayWithRepair(cursor.offset);
    if (replayResult.records.length === 0 && !replayResult.truncated) {
      return;
    }

    for (const record of replayResult.records) {
      this.applyRecord(record);
    }

    await this.replayCursor.commit({
      segment: 0,
      offset: replayResult.nextOffset,
    });
    await this.writeSnapshot();
  }

  list(): ThreadRecord[] {
    const main = this.getOrVirtual(MAIN_THREAD_ID) ?? createVirtualMainThread();
    const others = [...this.byThreadId.values()]
      .filter((record) => record.threadId !== MAIN_THREAD_ID)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return [main, ...others];
  }

  get(threadId: string): ThreadRecord | undefined {
    return this.byThreadId.get(threadId);
  }

  getOrVirtual(threadId: string): ThreadRecord | undefined {
    if (threadId === MAIN_THREAD_ID) {
      return this.byThreadId.get(MAIN_THREAD_ID) ?? createVirtualMainThread();
    }
    return this.byThreadId.get(threadId);
  }

  resolveMemoryScope(threadId: string): ThreadMemoryScope {
    return threadId === MAIN_THREAD_ID ? "main" : "spoke";
  }

  async create(input: { title?: string } = {}): Promise<ThreadRecord> {
    const createdAt = this.now();
    let threadId = this.newThreadId();
    while (threadId === MAIN_THREAD_ID || this.byThreadId.has(threadId)) {
      threadId = this.newThreadId();
    }
    const record: ThreadRecord = {
      threadId,
      title: input.title ?? "",
      archived: false,
      isDefault: false,
      createdAt,
      updatedAt: createdAt,
    };
    await this.persist({
      entry: { op: "upsert", ...record },
      apply: () => {
        this.byThreadId.set(record.threadId, record);
      },
    });
    return record;
  }

  async ensureForSessionKey(sessionKey: string): Promise<ThreadRecord> {
    if (sessionKey === MAIN_THREAD_ID) {
      const existingMain = this.byThreadId.get(MAIN_THREAD_ID);
      if (existingMain !== undefined) {
        return existingMain;
      }
      const now = this.now();
      const materializedMain: ThreadRecord = {
        threadId: MAIN_THREAD_ID,
        title: "Main",
        archived: false,
        isDefault: true,
        createdAt: now,
        updatedAt: now,
      };
      await this.persist({
        entry: { op: "upsert", ...materializedMain },
        apply: () => {
          this.byThreadId.set(MAIN_THREAD_ID, materializedMain);
        },
      });
      return materializedMain;
    }

    const existing = this.byThreadId.get(sessionKey);
    if (existing !== undefined) {
      return existing;
    }

    // v1 は sessionKey=threadId を正本として扱うため、
    // non-main では受け取った sessionKey を threadId として実体化する。
    const now = this.now();
    const created: ThreadRecord = {
      threadId: sessionKey,
      title: "",
      archived: false,
      isDefault: false,
      createdAt: now,
      updatedAt: now,
    };
    await this.persist({
      entry: { op: "upsert", ...created },
      apply: () => {
        this.byThreadId.set(created.threadId, created);
      },
    });
    return created;
  }

  async update(
    threadId: string,
    fields: {
      title?: string;
      archived?: boolean;
    }
  ): Promise<ThreadRecord | undefined> {
    const current = this.getOrVirtual(threadId);
    if (current === undefined) {
      return undefined;
    }
    if (threadId === MAIN_THREAD_ID && fields.archived === true) {
      throw new Error("INVALID_REQUEST: main thread cannot be archived");
    }

    const shouldMaterializeMain =
      threadId === MAIN_THREAD_ID &&
      this.byThreadId.get(MAIN_THREAD_ID) === undefined &&
      (fields.title !== undefined || fields.archived !== undefined);

    const nextUpdatedAt =
      fields.title !== undefined || fields.archived !== undefined || shouldMaterializeMain
        ? this.clampUpdatedAt(current.updatedAt, this.now(), current.threadId)
        : current.updatedAt;

    const next: ThreadRecord = {
      ...current,
      title: fields.title ?? current.title,
      archived: fields.archived ?? current.archived,
      updatedAt: nextUpdatedAt,
    };

    await this.persist({
      entry: { op: "upsert", ...next },
      apply: () => {
        this.byThreadId.set(next.threadId, next);
      },
    });
    return next;
  }

  async delete(threadId: string): Promise<boolean> {
    if (threadId === MAIN_THREAD_ID) {
      throw new Error("INVALID_REQUEST: main thread cannot be deleted");
    }
    if (!this.byThreadId.has(threadId)) {
      return false;
    }
    const deletedAt = this.now();
    await this.persist({
      entry: {
        op: "delete",
        threadId,
        deletedAt,
      },
      apply: () => {
        this.byThreadId.delete(threadId);
      },
    });
    return true;
  }

  private applyRecord(record: ThreadJournalEntry): void {
    if (record.op === "delete") {
      this.byThreadId.delete(record.threadId);
      return;
    }
    this.byThreadId.set(record.threadId, {
      threadId: record.threadId,
      title: record.title,
      archived: record.archived,
      isDefault: record.isDefault,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  }

  private async persist(input: { entry: ThreadJournalEntry; apply: () => void }): Promise<void> {
    const cursor = await this.journal.append(input.entry);
    input.apply();
    await this.writeSnapshot();
    await this.replayCursor.commit({ segment: 0, offset: cursor.offset + 1 });
  }

  private async loadSnapshot(): Promise<void> {
    try {
      const raw = await readFile(this.snapshotPath, "utf8");
      const snapshot = parseSnapshot(raw);
      if (snapshot === null) {
        return;
      }
      for (const thread of snapshot.threads) {
        this.byThreadId.set(thread.threadId, thread);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw error;
      }
    }
  }

  private async writeSnapshot(): Promise<void> {
    await mkdir(dirname(this.snapshotPath), { recursive: true });
    const snapshot: ThreadSnapshot = {
      version: 1,
      threads: [...this.byThreadId.values()],
    };
    await writeFile(this.snapshotPath, `${JSON.stringify(snapshot)}\n`, "utf8");
  }

  private async replayWithRepair(startOffset: number): Promise<{
    records: ThreadJournalEntry[];
    nextOffset: number;
    truncated: boolean;
  }> {
    const allLines = await this.readJournalLines();
    if (allLines.length === 0 || startOffset >= allLines.length) {
      return {
        records: [],
        nextOffset: Math.min(startOffset, allLines.length),
        truncated: false,
      };
    }

    const records: ThreadJournalEntry[] = [];
    let nextOffset = startOffset;
    let truncateAt: number | null = null;
    const latestUpdatedAtByThread = new Map<string, string>();
    for (const thread of this.byThreadId.values()) {
      latestUpdatedAtByThread.set(thread.threadId, thread.updatedAt);
    }

    for (let index = startOffset; index < allLines.length; index += 1) {
      const line = allLines[index];
      if (line === undefined) {
        continue;
      }
      try {
        const parsedRaw = JSON.parse(line) as unknown;
        const parsed = parseThreadJournalEntry(parsedRaw);
        if (parsed === null) {
          truncateAt = index;
          break;
        }
        if (parsed.op === "upsert") {
          const previousUpdatedAt = latestUpdatedAtByThread.get(parsed.threadId);
          const normalizedUpdatedAt = this.clampUpdatedAt(
            previousUpdatedAt,
            parsed.updatedAt,
            parsed.threadId
          );
          latestUpdatedAtByThread.set(parsed.threadId, normalizedUpdatedAt);
          records.push({
            ...parsed,
            updatedAt: normalizedUpdatedAt,
          });
        } else {
          latestUpdatedAtByThread.delete(parsed.threadId);
          records.push(parsed);
        }
        nextOffset = index + 1;
      } catch {
        truncateAt = index;
        break;
      }
    }

    if (truncateAt !== null) {
      const kept = allLines.slice(0, truncateAt);
      await mkdir(dirname(this.journalPath), { recursive: true });
      await writeFile(this.journalPath, kept.length > 0 ? `${kept.join("\n")}\n` : "", "utf8");
    }

    return {
      records,
      nextOffset,
      truncated: truncateAt !== null,
    };
  }

  private clampUpdatedAt(
    previousUpdatedAt: string | undefined,
    nextUpdatedAt: string,
    threadId: string
  ): string {
    if (previousUpdatedAt === undefined) {
      return nextUpdatedAt;
    }
    const previousMs = Date.parse(previousUpdatedAt);
    const nextMs = Date.parse(nextUpdatedAt);
    if (!Number.isFinite(previousMs) || !Number.isFinite(nextMs) || nextMs >= previousMs) {
      return nextUpdatedAt;
    }
    this.onWarn("thread-updated-at-clamped", {
      threadId,
      previousUpdatedAt,
      requestedUpdatedAt: nextUpdatedAt,
      clampedTo: previousUpdatedAt,
    });
    return previousUpdatedAt;
  }

  private async readJournalLines(): Promise<string[]> {
    try {
      const raw = await readFile(this.journalPath, "utf8");
      return raw
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }
}
