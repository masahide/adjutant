import { readFile } from "node:fs/promises";
import type { WatermarkStore } from "./watermark-store.js";
import type { TimelineActionType, TimelineRecordV1_5, WatermarksV1 } from "./types.js";
import { validateTimelineRecordV1_5 } from "./timeline-record.js";
import type { ProactiveMetrics } from "./metrics.js";

export type ParsedTimelineLine = {
  offset: number;
  nextOffset: number;
  record: Record<string, unknown>;
};

type SessionScanState = {
  openPostCount: number;
  oldestOpenPostTs?: string;
  oldestOpenActor?: string;
  hasOtherHumanReply: boolean;
  handledOffset?: number;
};

export type PendingFlusherOptions = {
  timelinePath: string;
  watermarkStore: WatermarkStore;
  staleMs?: number;
  nowMs?: () => number;
  enqueueSession: (input: {
    sessionKey: string;
    reason: string;
    openPostCount: number;
  }) => Promise<void> | void;
  metrics?: ProactiveMetrics;
  onWarn?: (message: string, meta?: Record<string, unknown>) => void;
};

export type PendingFlusher = {
  tick: () => Promise<{
    firedSessionKeys: string[];
    scannedRecords: number;
    suppressedSessionKeys: string[];
  }>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  if (!normalized) {
    return undefined;
  }
  return normalized;
}

function isTimelineActionType(value: unknown): value is TimelineActionType {
  return (
    value === "assistant_final" || value === "assistant_aborted" || value === "assistant_error"
  );
}

export function parseTimelineLines(raw: string): ParsedTimelineLine[] {
  const lines: ParsedTimelineLine[] = [];
  let offset = 0;
  const parts = raw.split("\n");
  for (let index = 0; index < parts.length; index += 1) {
    const line = parts[index] ?? "";
    const hasTrailingLf = index < parts.length - 1;
    const lineWithNewline = hasTrailingLf ? `${line}\n` : line;
    const lineBytes = Buffer.byteLength(lineWithNewline, "utf8");
    const nextOffset = offset + lineBytes;
    if (line.trim().length > 0) {
      try {
        const parsed = JSON.parse(line);
        const record = asRecord(parsed);
        if (record) {
          lines.push({
            offset,
            nextOffset,
            record,
          });
        }
      } catch {
        // ignore broken lines: store uses lastGoodOffset
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
  if (existing) {
    return existing;
  }
  const fromWatermark = watermarks.sessions[sessionKey];
  const created: SessionScanState = {
    openPostCount: fromWatermark?.open.openPostCount ?? 0,
    oldestOpenPostTs: fromWatermark?.open.oldestOpenPostTs,
    hasOtherHumanReply: false,
    handledOffset: fromWatermark?.handled.lastHandledOffset,
  };
  sessions.set(sessionKey, created);
  return created;
}

function applyRecordToSession(
  session: SessionScanState,
  record: TimelineRecordV1_5,
  offset: number
): void {
  if (record.recordType === "action" && record.actionType === "assistant_final") {
    session.handledOffset = offset;
    session.openPostCount = 0;
    session.oldestOpenPostTs = undefined;
    session.oldestOpenActor = undefined;
    session.hasOtherHumanReply = false;
    return;
  }

  if (record.recordType !== "event") {
    return;
  }
  if (record.role !== "user" || record.kind !== "post") {
    return;
  }
  if (typeof session.handledOffset === "number" && offset <= session.handledOffset) {
    return;
  }

  session.openPostCount += 1;
  if (!session.oldestOpenPostTs) {
    session.oldestOpenPostTs = record.loggedAt;
    session.oldestOpenActor = asString(record.actor);
  } else {
    const actor = asString(record.actor);
    if (session.oldestOpenActor && actor && actor !== session.oldestOpenActor) {
      session.hasOtherHumanReply = true;
    }
  }
}

function updateWatermarksFromSessions(
  watermarks: WatermarksV1,
  sessions: Map<string, SessionScanState>
): void {
  for (const [sessionKey, state] of sessions.entries()) {
    const existing = watermarks.sessions[sessionKey] ?? { handled: {}, open: {} };
    existing.handled.lastHandledOffset = state.handledOffset;
    existing.open.openPostCount = state.openPostCount;
    existing.open.oldestOpenPostTs = state.openPostCount > 0 ? state.oldestOpenPostTs : undefined;
    watermarks.sessions[sessionKey] = existing;
  }
}

function shouldFireSession(params: {
  session: SessionScanState;
  nowMs: number;
  staleMs: number;
}): boolean {
  if (params.session.openPostCount <= 0 || !params.session.oldestOpenPostTs) {
    return false;
  }
  const oldestMs = Date.parse(params.session.oldestOpenPostTs);
  if (!Number.isFinite(oldestMs)) {
    return false;
  }
  return params.nowMs - oldestMs >= params.staleMs;
}

export function createPendingFlusher(options: PendingFlusherOptions): PendingFlusher {
  const nowMs = options.nowMs ?? (() => Date.now());
  const staleMs = Math.max(1, Math.floor(options.staleMs ?? 900_000));

  return {
    tick: async () => {
      const recovered = await options.watermarkStore.recoverIfTimelineTruncated();
      const watermarks = recovered.watermarks;

      let raw = "";
      try {
        raw = await readFile(options.timelinePath, "utf8");
      } catch (error) {
        const errno = error as NodeJS.ErrnoException;
        if (errno.code !== "ENOENT") {
          throw error;
        }
      }

      const parsed = parseTimelineLines(raw);
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
        if (!sessionKey) {
          continue;
        }
        let timelineRecord: TimelineRecordV1_5;
        try {
          timelineRecord = validateTimelineRecordV1_5(line.record);
        } catch {
          continue;
        }
        const actionType = timelineRecord.actionType;
        if (actionType !== undefined && !isTimelineActionType(actionType)) {
          continue;
        }
        const state = ensureSessionState(sessions, watermarks, sessionKey);
        applyRecordToSession(state, timelineRecord, line.offset);
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
        options.metrics?.recordFlusherFire({
          sessionKey,
          openPostCount: state.openPostCount,
        });
        firedSessionKeys.push(sessionKey);
      }

      updateWatermarksFromSessions(watermarks, sessions);
      watermarks.scan.lastGoodOffset = lastGoodOffset;
      watermarks.scan.lastScannedOffset = lastGoodOffset;
      watermarks.updatedAt = new Date(now).toISOString();
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
