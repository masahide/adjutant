import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { AcceptedResponse, SessionRecoveryMode } from "./contracts/http-api.js";
import { JournalStore } from "../runtime/journal-store.js";

export type IdempotencyScope = "command" | "ingest";

interface CommandAcceptedValue {
  messageId: string;
  status: "accepted";
  acceptedAt: string;
  runId: string;
  sessionRecovered?: boolean;
  sessionRecoveryMode?: SessionRecoveryMode;
  sessionRecoveryReason?: string;
}

interface IngestAcceptedValue {
  messageId: string;
}

interface IdempotencyEntry {
  version: 1;
  scope: IdempotencyScope;
  key: string;
  requestHash: string;
  accepted: unknown;
  updatedAt: string;
}

interface IdempotencySnapshot {
  version: 1;
  entries: IdempotencyEntry[];
}

type CommandResolution =
  | { kind: "miss" }
  | { kind: "duplicate"; accepted: AcceptedResponse }
  | { kind: "conflict"; message: string };

type IngestResolution =
  | { kind: "miss" }
  | { kind: "duplicate"; canonicalMessageId: string }
  | { kind: "conflict"; message: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCommandAcceptedValue(value: unknown): value is CommandAcceptedValue {
  const sessionRecoveryMode = isObject(value) ? value.sessionRecoveryMode : undefined;
  const validRecoveryMode =
    sessionRecoveryMode === undefined ||
    sessionRecoveryMode === "in_memory" ||
    sessionRecoveryMode === "session_load" ||
    sessionRecoveryMode === "new_session" ||
    sessionRecoveryMode === "fallback_new_session";
  return (
    isObject(value) &&
    typeof value.messageId === "string" &&
    value.status === "accepted" &&
    typeof value.acceptedAt === "string" &&
    typeof value.runId === "string" &&
    (value.sessionRecovered === undefined || typeof value.sessionRecovered === "boolean") &&
    validRecoveryMode &&
    (value.sessionRecoveryReason === undefined || typeof value.sessionRecoveryReason === "string")
  );
}

function isIngestAcceptedValue(value: unknown): value is IngestAcceptedValue {
  return isObject(value) && typeof value.messageId === "string";
}

function isIdempotencyEntry(value: unknown): value is IdempotencyEntry {
  return (
    isObject(value) &&
    value.version === 1 &&
    (value.scope === "command" || value.scope === "ingest") &&
    typeof value.key === "string" &&
    typeof value.requestHash === "string" &&
    value.accepted !== undefined &&
    typeof value.updatedAt === "string"
  );
}

function parseSnapshot(raw: string): IdempotencySnapshot | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isObject(parsed) || parsed.version !== 1 || !Array.isArray(parsed.entries)) {
      return null;
    }
    const entries = parsed.entries.filter((entry): entry is IdempotencyEntry =>
      isIdempotencyEntry(entry)
    );
    return {
      version: 1,
      entries,
    };
  } catch {
    return null;
  }
}

function toScopedKey(scope: IdempotencyScope, key: string): string {
  return `${scope}:${key}`;
}

interface IdempotencyStoreOptions {
  journalPath: string;
  snapshotPath: string;
  now?: () => string;
  onWarn?: (message: string, meta?: Record<string, unknown>) => void;
}

export class IdempotencyStore {
  private readonly entriesByScopedKey = new Map<string, IdempotencyEntry>();
  private readonly journal: JournalStore<IdempotencyEntry>;
  private readonly snapshotPath: string;
  private readonly now: () => string;
  private readonly onWarn: (message: string, meta?: Record<string, unknown>) => void;

  constructor(options: IdempotencyStoreOptions) {
    this.journal = new JournalStore(options.journalPath);
    this.snapshotPath = options.snapshotPath;
    this.now = options.now ?? (() => new Date().toISOString());
    this.onWarn = options.onWarn ?? (() => {});
  }

  static fromStateDir(
    stateDir: string,
    options?: {
      onWarn?: (message: string, meta?: Record<string, unknown>) => void;
    }
  ): IdempotencyStore {
    return new IdempotencyStore({
      journalPath: join(stateDir, "journal", "control-plane", "idempotency.jsonl"),
      snapshotPath: join(stateDir, "cursor", "control-plane.idempotency.snapshot.json"),
      onWarn: options?.onWarn,
    });
  }

  async initialize(): Promise<void> {
    await this.loadSnapshot();
    const records = await this.journal.drain({ segment: 0, offset: 0 });
    for (const record of records) {
      if (!isIdempotencyEntry(record.value)) {
        this.onWarn("idempotency.invalid_journal_record", {
          segment: record.cursor.segment,
          offset: record.cursor.offset,
        });
        continue;
      }
      this.entriesByScopedKey.set(toScopedKey(record.value.scope, record.value.key), record.value);
    }
    await this.writeSnapshot();
  }

  resolveCommand(
    sessionKey: string,
    idempotencyKey: string,
    requestHash: string
  ): CommandResolution {
    const key = `${sessionKey}:${idempotencyKey}`;
    const existing = this.entriesByScopedKey.get(toScopedKey("command", key));
    if (existing === undefined) {
      return { kind: "miss" };
    }
    if (existing.requestHash !== requestHash) {
      return {
        kind: "conflict",
        message: "same idempotencyKey was used with different payload",
      };
    }
    if (!isCommandAcceptedValue(existing.accepted)) {
      this.onWarn("idempotency.invalid_command_accepted", { key });
      return { kind: "miss" };
    }
    return {
      kind: "duplicate",
      accepted: existing.accepted,
    };
  }

  async bindCommand(input: {
    sessionKey: string;
    idempotencyKey: string;
    requestHash: string;
    accepted: AcceptedResponse;
  }): Promise<void> {
    const key = `${input.sessionKey}:${input.idempotencyKey}`;
    await this.append({
      scope: "command",
      key,
      requestHash: input.requestHash,
      accepted: input.accepted,
    });
  }

  resolveIngest(dedupeKey: string, payloadHash: string): IngestResolution {
    const existing = this.entriesByScopedKey.get(toScopedKey("ingest", dedupeKey));
    if (existing === undefined) {
      return { kind: "miss" };
    }
    if (existing.requestHash !== payloadHash) {
      return {
        kind: "conflict",
        message: "same dedupeKey with different payload is not allowed",
      };
    }
    if (!isIngestAcceptedValue(existing.accepted)) {
      this.onWarn("idempotency.invalid_ingest_accepted", { dedupeKey });
      return { kind: "miss" };
    }
    return {
      kind: "duplicate",
      canonicalMessageId: existing.accepted.messageId,
    };
  }

  async bindIngest(input: {
    dedupeKey: string;
    payloadHash: string;
    canonicalMessageId: string;
  }): Promise<void> {
    await this.append({
      scope: "ingest",
      key: input.dedupeKey,
      requestHash: input.payloadHash,
      accepted: {
        messageId: input.canonicalMessageId,
      },
    });
  }

  private async append(input: {
    scope: IdempotencyScope;
    key: string;
    requestHash: string;
    accepted: unknown;
  }): Promise<void> {
    const entry: IdempotencyEntry = {
      version: 1,
      scope: input.scope,
      key: input.key,
      requestHash: input.requestHash,
      accepted: input.accepted,
      updatedAt: this.now(),
    };
    await this.journal.append(entry);
    this.entriesByScopedKey.set(toScopedKey(entry.scope, entry.key), entry);
    await this.writeSnapshot();
  }

  private async loadSnapshot(): Promise<void> {
    try {
      const raw = await readFile(this.snapshotPath, "utf8");
      const snapshot = parseSnapshot(raw);
      if (snapshot === null) {
        return;
      }
      for (const entry of snapshot.entries) {
        this.entriesByScopedKey.set(toScopedKey(entry.scope, entry.key), entry);
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
    const snapshot: IdempotencySnapshot = {
      version: 1,
      entries: [...this.entriesByScopedKey.values()],
    };
    await writeFile(this.snapshotPath, `${JSON.stringify(snapshot)}\n`, "utf8");
  }
}
