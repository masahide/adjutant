import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { CursorStore } from "../../runtime/cursor-store.js";
import { JournalStore } from "../../runtime/journal-store.js";

export interface SessionRecoveryState {
  sessionKey: string;
  sessionId: string;
  lastRunId?: string;
  updatedAt: string;
}

interface SessionRecoverySnapshot {
  version: 1;
  sessions: SessionRecoveryState[];
}

interface SessionRecoveryStoreOptions {
  journalPath: string;
  replayCursorPath: string;
  snapshotPath: string;
  now?: () => string;
  onWarn?: (message: string, meta?: Record<string, unknown>) => void;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSnapshot(raw: string): SessionRecoverySnapshot | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isObject(parsed) || parsed.version !== 1 || !Array.isArray(parsed.sessions)) {
      return null;
    }

    const sessions = parsed.sessions.filter((entry): entry is SessionRecoveryState => {
      return (
        isObject(entry) &&
        typeof entry.sessionKey === "string" &&
        typeof entry.sessionId === "string" &&
        typeof entry.updatedAt === "string" &&
        (entry.lastRunId === undefined || typeof entry.lastRunId === "string")
      );
    });

    return {
      version: 1,
      sessions,
    };
  } catch {
    return null;
  }
}

export class SessionRecoveryStore {
  private readonly bySessionKey = new Map<string, SessionRecoveryState>();
  private readonly journal: JournalStore<SessionRecoveryState>;
  private readonly journalPath: string;
  private readonly replayCursor: CursorStore;
  private readonly snapshotPath: string;
  private readonly now: () => string;
  private readonly onWarn: (message: string, meta?: Record<string, unknown>) => void;

  constructor(options: SessionRecoveryStoreOptions) {
    this.journalPath = options.journalPath;
    this.journal = new JournalStore(options.journalPath);
    this.replayCursor = new CursorStore(options.replayCursorPath);
    this.snapshotPath = options.snapshotPath;
    this.now = options.now ?? (() => new Date().toISOString());
    this.onWarn = options.onWarn ?? (() => {});
  }

  static fromStateDir(
    stateDir: string,
    options?: { onWarn?: (message: string, meta?: Record<string, unknown>) => void }
  ): SessionRecoveryStore {
    return new SessionRecoveryStore({
      journalPath: join(stateDir, "journal", "control-plane", "session-recovery.jsonl"),
      replayCursorPath: join(
        stateDir,
        "cursor",
        "control-plane.session-recovery.replay-cursor.json"
      ),
      snapshotPath: join(stateDir, "cursor", "control-plane.session-recovery.snapshot.json"),
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
      this.bySessionKey.set(record.sessionKey, record);
    }
    await this.replayCursor.commit({
      segment: 0,
      offset: replayResult.nextOffset,
    });
    await this.writeSnapshot();
  }

  get(sessionKey: string): SessionRecoveryState | undefined {
    return this.bySessionKey.get(sessionKey);
  }

  list(): SessionRecoveryState[] {
    return [...this.bySessionKey.values()];
  }

  async upsert(input: {
    sessionKey: string;
    sessionId: string;
    lastRunId?: string;
  }): Promise<SessionRecoveryState> {
    const current = this.bySessionKey.get(input.sessionKey);
    const rawNow = this.now();
    const updatedAt = this.clampUpdatedAt(current?.updatedAt, rawNow, input.sessionKey);
    const next: SessionRecoveryState = {
      sessionKey: input.sessionKey,
      sessionId: input.sessionId,
      lastRunId: input.lastRunId ?? current?.lastRunId,
      updatedAt,
    };

    const cursor = await this.journal.append(next);
    this.bySessionKey.set(next.sessionKey, next);
    await this.writeSnapshot();
    await this.replayCursor.commit({ segment: 0, offset: cursor.offset + 1 });
    return next;
  }

  private async loadSnapshot(): Promise<void> {
    try {
      const raw = await readFile(this.snapshotPath, "utf8");
      const snapshot = parseSnapshot(raw);
      if (snapshot === null) {
        return;
      }
      for (const session of snapshot.sessions) {
        this.bySessionKey.set(session.sessionKey, session);
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
    const snapshot: SessionRecoverySnapshot = {
      version: 1,
      sessions: this.list(),
    };
    await writeFile(this.snapshotPath, `${JSON.stringify(snapshot)}\n`, "utf8");
  }

  private async replayWithRepair(startOffset: number): Promise<{
    records: SessionRecoveryState[];
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

    const records: SessionRecoveryState[] = [];
    let nextOffset = startOffset;
    let truncateAt: number | null = null;
    const lastFingerprintBySession = new Map<string, string>();
    const lastUpdatedAtBySession = new Map<string, string>();
    for (const existing of this.bySessionKey.values()) {
      lastFingerprintBySession.set(
        existing.sessionKey,
        `${existing.sessionId}|${existing.lastRunId ?? ""}|${existing.updatedAt}`
      );
      lastUpdatedAtBySession.set(existing.sessionKey, existing.updatedAt);
    }

    for (let index = startOffset; index < allLines.length; index += 1) {
      const line = allLines[index];
      if (line === undefined) {
        continue;
      }

      try {
        const parsed = JSON.parse(line) as unknown;
        if (!this.isSessionRecoveryState(parsed)) {
          truncateAt = index;
          break;
        }
        const normalized = this.normalizeReplayRecord({
          record: parsed,
          index,
          lastFingerprintBySession,
          lastUpdatedAtBySession,
        });
        if (normalized !== null) {
          records.push(normalized);
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

  private isSessionRecoveryState(value: unknown): value is SessionRecoveryState {
    return (
      isObject(value) &&
      typeof value.sessionKey === "string" &&
      typeof value.sessionId === "string" &&
      (value.lastRunId === undefined || typeof value.lastRunId === "string") &&
      typeof value.updatedAt === "string"
    );
  }

  private clampUpdatedAt(
    previousUpdatedAt: string | undefined,
    nextUpdatedAt: string,
    sessionKey: string
  ): string {
    if (previousUpdatedAt === undefined) {
      return nextUpdatedAt;
    }
    const prevMs = Date.parse(previousUpdatedAt);
    const nextMs = Date.parse(nextUpdatedAt);
    if (!Number.isFinite(prevMs) || !Number.isFinite(nextMs) || nextMs >= prevMs) {
      return nextUpdatedAt;
    }
    this.onWarn("session-recovery-updated-at-clamped", {
      sessionKey,
      previousUpdatedAt,
      requestedUpdatedAt: nextUpdatedAt,
      clampedTo: previousUpdatedAt,
    });
    return previousUpdatedAt;
  }

  private normalizeReplayRecord(input: {
    record: SessionRecoveryState;
    index: number;
    lastFingerprintBySession: Map<string, string>;
    lastUpdatedAtBySession: Map<string, string>;
  }): SessionRecoveryState | null {
    const fingerprint = `${input.record.sessionId}|${input.record.lastRunId ?? ""}|${input.record.updatedAt}`;
    const previousFingerprint = input.lastFingerprintBySession.get(input.record.sessionKey);
    if (previousFingerprint === fingerprint) {
      this.onWarn("session-recovery-duplicate-record", {
        sessionKey: input.record.sessionKey,
        sessionId: input.record.sessionId,
        offset: input.index,
      });
      return null;
    }
    input.lastFingerprintBySession.set(input.record.sessionKey, fingerprint);

    const previousUpdatedAt = input.lastUpdatedAtBySession.get(input.record.sessionKey);
    const normalizedUpdatedAt = this.clampUpdatedAt(
      previousUpdatedAt,
      input.record.updatedAt,
      input.record.sessionKey
    );
    input.lastUpdatedAtBySession.set(input.record.sessionKey, normalizedUpdatedAt);
    if (normalizedUpdatedAt === input.record.updatedAt) {
      return input.record;
    }
    return {
      ...input.record,
      updatedAt: normalizedUpdatedAt,
    };
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
