import { join } from "node:path";

import type { DeliverEnqueueRequest } from "../../contracts/process-rpc/method-types.js";
import { CursorStore } from "../../runtime/cursor-store.js";
import { JournalStore, type Cursor, type JournalRecord } from "../../runtime/journal-store.js";

export interface DeliverQueueEntry {
  version: 1;
  enqueuedAt: string;
  request: DeliverEnqueueRequest;
  nextAttemptAt: string;
  state: "pending" | "inflight" | "terminal";
}

export class DeliverQueueStore {
  private readonly journal: JournalStore<DeliverQueueEntry>;
  private readonly replayCursor: CursorStore;
  private currentReplayCursor: Cursor = { segment: 0, offset: 0 };
  private readonly now: () => string;

  constructor(options: { journalPath: string; replayCursorPath: string; now?: () => string }) {
    this.journal = new JournalStore(options.journalPath);
    this.replayCursor = new CursorStore(options.replayCursorPath);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  static fromStateDir(
    stateDir: string,
    options?: {
      now?: () => string;
    }
  ): DeliverQueueStore {
    return new DeliverQueueStore({
      journalPath: join(stateDir, "journal", "control-plane", "deliver-queue.jsonl"),
      replayCursorPath: join(stateDir, "cursor", "control-plane.deliver-queue.json"),
      now: options?.now,
    });
  }

  async initialize(): Promise<void> {
    this.currentReplayCursor = await this.replayCursor.load();
  }

  async append(input: {
    request: DeliverEnqueueRequest;
    state?: DeliverQueueEntry["state"];
    nextAttemptAt?: string;
  }): Promise<Cursor> {
    const enqueuedAt = this.now();
    return await this.journal.append({
      version: 1,
      enqueuedAt,
      request: input.request,
      nextAttemptAt: input.nextAttemptAt ?? enqueuedAt,
      state: input.state ?? "pending",
    });
  }

  async replayPending(
    limit = Number.POSITIVE_INFINITY
  ): Promise<JournalRecord<DeliverQueueEntry>[]> {
    return await this.journal.drain(this.currentReplayCursor, limit);
  }

  async commitThrough(cursor: Cursor): Promise<void> {
    const next: Cursor = {
      segment: cursor.segment,
      offset: cursor.offset + 1,
    };
    if (
      next.segment < this.currentReplayCursor.segment ||
      (next.segment === this.currentReplayCursor.segment &&
        next.offset <= this.currentReplayCursor.offset)
    ) {
      return;
    }
    await this.replayCursor.commit(next);
    this.currentReplayCursor = next;
  }

  currentCursor(): Cursor {
    return this.currentReplayCursor;
  }
}
