import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { NormalizedEvent } from "../../core/events.js";
import {
  TIMELINE_RECORD_SCHEMA_V1_5,
  type TimelineActionRecordV1_5,
  type TimelineActionType,
  type TimelineEventRecordV1_5,
  type TimelineRecordV1_5,
  validateTimelineRecordV1_5,
} from "./schema.js";

type TimelineStoreOptions = {
  path: string;
  nowIso?: () => string;
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeSessionKey(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error("timeline record requires sessionKey");
  }
  return normalized;
}

function normalizeUid(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error("timeline record requires uid");
  }
  return normalized;
}

async function fileSize(path: string): Promise<number> {
  try {
    const info = await stat(path);
    return Math.max(0, Number(info.size));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return 0;
    }
    throw error;
  }
}

export class TimelineStore {
  private readonly path: string;
  private readonly nowIso: () => string;

  constructor(options: TimelineStoreOptions) {
    this.path = options.path;
    this.nowIso = options.nowIso ?? (() => new Date().toISOString());
  }

  static fromStateDir(stateDir: string): TimelineStore {
    return new TimelineStore({
      path: join(stateDir, "timeline.jsonl"),
    });
  }

  pathForDebug(): string {
    return this.path;
  }

  async appendEvent(input: {
    sessionKey: string;
    uid: string;
    ts: string;
    event: NormalizedEvent;
    loggedAt?: string;
  }): Promise<TimelineEventRecordV1_5> {
    const base: Omit<TimelineEventRecordV1_5, "timelineOffset"> = {
      schema: TIMELINE_RECORD_SCHEMA_V1_5,
      recordType: "event" as const,
      sessionKey: normalizeSessionKey(input.sessionKey),
      uid: normalizeUid(input.uid),
      ts: input.ts,
      loggedAt: input.loggedAt ?? this.nowIso(),
      event: input.event,
    };
    return await this.append(base);
  }

  async appendAction(input: {
    sessionKey: string;
    uid: string;
    ts: string;
    actionType: TimelineActionType;
    runId?: string;
    loggedAt?: string;
  }): Promise<TimelineActionRecordV1_5> {
    const base: Omit<TimelineActionRecordV1_5, "timelineOffset"> = {
      schema: TIMELINE_RECORD_SCHEMA_V1_5,
      recordType: "action" as const,
      sessionKey: normalizeSessionKey(input.sessionKey),
      uid: normalizeUid(input.uid),
      ts: input.ts,
      loggedAt: input.loggedAt ?? this.nowIso(),
      actionType: input.actionType,
      runId: input.runId,
    };
    return await this.append(base);
  }

  async readRecords(): Promise<TimelineRecordV1_5[]> {
    let raw = "";
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
    const lines = raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const records: TimelineRecordV1_5[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as unknown;
        if (validateTimelineRecordV1_5(parsed)) {
          records.push(parsed);
        }
      } catch {
        // Ignore malformed lines: timeline is append-only and read path is best effort.
      }
    }
    return records;
  }

  private async append<TRecord extends TimelineRecordV1_5>(
    record: Omit<TRecord, "timelineOffset">
  ): Promise<TRecord> {
    await mkdir(dirname(this.path), { recursive: true });
    const offset = await fileSize(this.path);
    const nextRecord: TRecord = {
      ...record,
      timelineOffset: offset,
    } as TRecord;
    await appendFile(this.path, `${JSON.stringify(nextRecord)}\n`, "utf8");
    return clone(nextRecord);
  }
}
