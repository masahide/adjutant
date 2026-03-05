import { readFile } from "node:fs/promises";

import type { NormalizedEvent } from "../../core/events.js";
import {
  type TimelineRecordV1_5,
  type WatermarksV1,
  validateTimelineRecordV1_5,
} from "./schema.js";
import type { WatermarkStore } from "./watermark-store.js";

export type ParsedTimelineLine = {
  offset: number;
  nextOffset: number;
  record: Record<string, unknown>;
};

type SessionScanState = {
  openPostCount: number;
  oldestOpenAt?: string;
  oldestActor?: string;
  hasOtherHumanReply: boolean;
  handledOffset?: number;
};

export type PendingFlusherOptions = {
  timelinePath: string;
  watermarkStore: Pick<
    WatermarkStore,
    "recoverIfTimelineTruncated" | "save" | "pruneSessions" | "load"
  >;
  staleMs?: number;
  nowMs?: () => number;
  enqueueSession: (input: {
    sessionKey: string;
    reason: string;
    openPostCount: number;
  }) => Promise<void> | void;
};

export type PendingFlusherTickResult = {
  firedSessionKeys: string[];
  scannedRecords: number;
  suppressedSessionKeys: string[];
};

export type PendingFlusher = {
  tick: () => Promise<PendingFlusherTickResult>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function parseTimelineLines(raw: string): ParsedTimelineLine[] {
  const lines: ParsedTimelineLine[] = [];
  let offset = 0;
  const split = raw.split("\n");
  for (let index = 0; index < split.length; index += 1) {
    const line = split[index] ?? "";
    const hasTrailingLf = index < split.length - 1;
    const lineWithLf = hasTrailingLf ? `${line}\n` : line;
    const nextOffset = offset + Buffer.byteLength(lineWithLf, "utf8");
    if (line.trim().length > 0) {
      try {
        const parsed = JSON.parse(line) as unknown;
        const record = asRecord(parsed);
        if (record !== null) {
          lines.push({
            offset,
            nextOffset,
            record,
          });
        }
      } catch {
        // Keep scanning, rely on lastGoodOffset to recover.
      }
    }
    offset = nextOffset;
  }
  return lines;
}

function ensureSessionState(
  sessions: Map<string, SessionScanState>,
  watermarks: WatermarksV1,
  sessionKey: string
): SessionScanState {
  const existing = sessions.get(sessionKey);
  if (existing !== undefined) {
    return existing;
  }
  const fromWatermark = watermarks.sessions[sessionKey];
  const created: SessionScanState = {
    openPostCount: fromWatermark?.open.openPostCount ?? 0,
    oldestOpenAt: fromWatermark?.open.oldestOpenAt,
    oldestActor: fromWatermark?.open.oldestActor,
    hasOtherHumanReply: false,
    handledOffset: fromWatermark?.handled.lastHandledOffset,
  };
  sessions.set(sessionKey, created);
  return created;
}

function isSlackUserPost(event: NormalizedEvent): boolean {
  return event.source === "slack" && event.kind === "post";
}

function applyEventRecordToSession(
  session: SessionScanState,
  record: TimelineRecordV1_5,
  offset: number
): void {
  if (record.recordType !== "event") {
    return;
  }
  const event = record.event;
  if (!isSlackUserPost(event)) {
    return;
  }
  if (typeof session.handledOffset === "number" && offset <= session.handledOffset) {
    return;
  }
  session.openPostCount += 1;
  if (session.oldestOpenAt === undefined) {
    session.oldestOpenAt = record.loggedAt;
    session.oldestActor = asString(event.actor);
    return;
  }

  const actor = asString(event.actor);
  if (session.oldestActor !== undefined && actor !== undefined && actor !== session.oldestActor) {
    session.hasOtherHumanReply = true;
  }
}

function applyActionRecordToSession(
  session: SessionScanState,
  record: TimelineRecordV1_5,
  offset: number
): void {
  if (record.recordType !== "action") {
    return;
  }
  if (record.actionType !== "assistant_final") {
    return;
  }
  session.handledOffset = offset;
  session.openPostCount = 0;
  session.oldestOpenAt = undefined;
  session.oldestActor = undefined;
  session.hasOtherHumanReply = false;
}

function updateWatermarksFromSessions(
  watermarks: WatermarksV1,
  sessions: Map<string, SessionScanState>
): void {
  for (const [sessionKey, state] of sessions.entries()) {
    const existing = watermarks.sessions[sessionKey] ?? {
      handled: { lastHandledOffset: 0 },
      open: { openPostCount: 0 },
    };
    if (typeof state.handledOffset === "number") {
      existing.handled.lastHandledOffset = Math.max(0, Math.floor(state.handledOffset));
    }
    existing.open.openPostCount = Math.max(0, Math.floor(state.openPostCount));
    existing.open.oldestOpenAt = existing.open.openPostCount > 0 ? state.oldestOpenAt : undefined;
    existing.open.oldestActor = existing.open.openPostCount > 0 ? state.oldestActor : undefined;
    watermarks.sessions[sessionKey] = existing;
  }
}

function shouldFireSession(params: {
  session: SessionScanState;
  nowMs: number;
  staleMs: number;
}): boolean {
  if (params.session.openPostCount <= 0 || params.session.oldestOpenAt === undefined) {
    return false;
  }
  const oldest = Date.parse(params.session.oldestOpenAt);
  if (!Number.isFinite(oldest)) {
    return false;
  }
  return params.nowMs - oldest >= params.staleMs;
}

export function createPendingFlusher(options: PendingFlusherOptions): PendingFlusher {
  const nowMs = options.nowMs ?? (() => Date.now());
  const staleMs = Math.max(1, Math.floor(options.staleMs ?? 900_000));

  return {
    tick: async (): Promise<PendingFlusherTickResult> => {
      const recovered = await options.watermarkStore.recoverIfTimelineTruncated();
      const watermarks = recovered.watermarks;

      let rawTimeline = "";
      try {
        rawTimeline = await readFile(options.timelinePath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }

      const parsed = parseTimelineLines(rawTimeline);
      const sessions = new Map<string, SessionScanState>();
      let lastGoodOffset = watermarks.scan.lastGoodOffset;
      let scannedRecords = 0;
      for (const line of parsed) {
        lastGoodOffset = Math.max(lastGoodOffset, line.nextOffset);
        if (line.offset < watermarks.scan.lastScannedOffset) {
          continue;
        }
        scannedRecords += 1;
        const sessionKey = asString(line.record.sessionKey);
        if (sessionKey === undefined) {
          continue;
        }
        let record: TimelineRecordV1_5;
        if (!validateTimelineRecordV1_5(line.record)) {
          continue;
        }
        record = line.record;
        const state = ensureSessionState(sessions, watermarks, sessionKey);
        applyActionRecordToSession(state, record, line.offset);
        applyEventRecordToSession(state, record, line.offset);
      }

      const firedSessionKeys: string[] = [];
      const suppressedSessionKeys: string[] = [];
      const now = nowMs();
      for (const [sessionKey, state] of sessions.entries()) {
        if (!shouldFireSession({ session: state, nowMs: now, staleMs })) {
          continue;
        }
        if (state.hasOtherHumanReply) {
          suppressedSessionKeys.push(sessionKey);
          continue;
        }
        await options.enqueueSession({
          sessionKey,
          reason: "stale-open-post",
          openPostCount: state.openPostCount,
        });
        firedSessionKeys.push(sessionKey);
      }

      updateWatermarksFromSessions(watermarks, sessions);
      watermarks.scan.lastGoodOffset = lastGoodOffset;
      watermarks.scan.lastScannedOffset = lastGoodOffset;
      await options.watermarkStore.save(watermarks);
      await options.watermarkStore.pruneSessions();

      return {
        firedSessionKeys,
        scannedRecords,
        suppressedSessionKeys,
      };
    },
  };
}
