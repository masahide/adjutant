import { join } from "node:path";

import type { CollectorIngestRequest } from "../../contracts/process-rpc/method-types.js";
import { CursorStore } from "../../runtime/cursor-store.js";
import { JournalStore, type Cursor, type JournalRecord } from "../../runtime/journal-store.js";
import type { IngestProjection } from "./ingest-projection.js";

export interface IngestInboxEntry {
  version: 1;
  receivedAt: string;
  request: CollectorIngestRequest;
  projection: IngestProjection;
}

export class IngestInboxStore {
  private readonly journal: JournalStore<IngestInboxEntry>;
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
  ): IngestInboxStore {
    return new IngestInboxStore({
      journalPath: join(stateDir, "journal", "control-plane", "inbox.jsonl"),
      replayCursorPath: join(stateDir, "cursor", "control-plane.inbox.json"),
      now: options?.now,
    });
  }

  async initialize(): Promise<void> {
    this.currentReplayCursor = await this.replayCursor.load();
  }

  async append(input: {
    request: CollectorIngestRequest;
    projection: IngestProjection;
  }): Promise<Cursor> {
    return await this.journal.append({
      version: 1,
      receivedAt: this.now(),
      request: input.request,
      projection: input.projection,
    });
  }

  async replayPending(
    limit = Number.POSITIVE_INFINITY
  ): Promise<JournalRecord<IngestInboxEntry>[]> {
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
