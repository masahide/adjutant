import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { DeliverCompletedNotification } from "../contracts/process-rpc/method-types.js";

export interface DeliverCompletionState {
  messageId: string;
  status: "completed" | "failed";
  finishedAt: string;
  error?: string;
}

export interface DeliverApplyResult {
  applied: boolean;
  duplicate: boolean;
  final: DeliverCompletionState;
}

interface DeliverCompletionSnapshot {
  version: 1;
  entries: DeliverCompletionState[];
}

interface DeliverCompletionStoreOptions {
  snapshotPath?: string;
}

function sameState(a: DeliverCompletionState, b: DeliverCompletionState): boolean {
  return a.status === b.status && a.finishedAt === b.finishedAt && a.error === b.error;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDeliverCompletionState(value: unknown): value is DeliverCompletionState {
  return (
    isObject(value) &&
    typeof value.messageId === "string" &&
    (value.status === "completed" || value.status === "failed") &&
    typeof value.finishedAt === "string" &&
    (value.error === undefined || typeof value.error === "string")
  );
}

function parseSnapshot(raw: string): DeliverCompletionSnapshot | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isObject(parsed) || parsed.version !== 1 || !Array.isArray(parsed.entries)) {
      return null;
    }
    const entries = parsed.entries.filter((entry): entry is DeliverCompletionState =>
      isDeliverCompletionState(entry)
    );
    return {
      version: 1,
      entries,
    };
  } catch {
    return null;
  }
}

export class DeliverCompletionStore {
  private readonly byMessageId = new Map<string, DeliverCompletionState>();
  private readonly snapshotPath?: string;

  constructor(options: DeliverCompletionStoreOptions = {}) {
    this.snapshotPath = options.snapshotPath;
  }

  static fromStateDir(stateDir: string): DeliverCompletionStore {
    return new DeliverCompletionStore({
      snapshotPath: join(stateDir, "cursor", "control-plane.deliver-completion.snapshot.json"),
    });
  }

  async initialize(): Promise<void> {
    if (this.snapshotPath === undefined) {
      return;
    }
    try {
      const raw = await readFile(this.snapshotPath, "utf8");
      const snapshot = parseSnapshot(raw);
      if (snapshot === null) {
        return;
      }
      this.byMessageId.clear();
      for (const entry of snapshot.entries) {
        this.byMessageId.set(entry.messageId, entry);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw error;
      }
    }
  }

  apply(event: DeliverCompletedNotification): DeliverApplyResult {
    const next: DeliverCompletionState = {
      messageId: event.messageId,
      status: event.status,
      finishedAt: event.finishedAt,
      error: event.error,
    };

    const current = this.byMessageId.get(event.messageId);
    if (current === undefined) {
      this.byMessageId.set(event.messageId, next);
      return {
        applied: true,
        duplicate: false,
        final: next,
      };
    }

    if (sameState(current, next)) {
      return {
        applied: false,
        duplicate: true,
        final: current,
      };
    }

    if (current.status === "completed" && next.status === "failed") {
      return {
        applied: false,
        duplicate: false,
        final: current,
      };
    }

    if (current.status === "failed" && next.status === "completed") {
      this.byMessageId.set(event.messageId, next);
      return {
        applied: true,
        duplicate: false,
        final: next,
      };
    }

    this.byMessageId.set(event.messageId, next);
    return {
      applied: true,
      duplicate: false,
      final: next,
    };
  }

  get(messageId: string): DeliverCompletionState | undefined {
    return this.byMessageId.get(messageId);
  }

  list(): DeliverCompletionState[] {
    return [...this.byMessageId.values()];
  }

  async persist(): Promise<void> {
    if (this.snapshotPath === undefined) {
      return;
    }
    await mkdir(dirname(this.snapshotPath), { recursive: true });
    const snapshot: DeliverCompletionSnapshot = {
      version: 1,
      entries: this.list(),
    };
    await writeFile(this.snapshotPath, `${JSON.stringify(snapshot)}\n`, "utf8");
  }
}
