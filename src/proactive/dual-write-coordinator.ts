export type DualWriteRecord = {
  uid: string;
  sessionKey: string;
  [key: string]: unknown;
};

export type DualWriteAppendResult =
  | { status: "committed" }
  | { status: "pending-timeline" }
  | { status: "pending-session-backfill" };

export type DualWriteRetryResult = {
  timelineRecovered: number;
  sessionRecovered: number;
  pendingTimeline: number;
  pendingSessionBackfill: number;
};

export type DualWriteCoordinatorDeps = {
  appendTimelineRecord: (record: DualWriteRecord) => Promise<void>;
  appendSessionRecord: (record: DualWriteRecord) => Promise<void>;
  nowMs?: () => number;
  backfillWarningMs?: number;
  onWarn?: (message: string, meta?: Record<string, unknown>) => void;
};

type PendingWrite = {
  uid: string;
  timelineRecord: DualWriteRecord;
  sessionRecord: DualWriteRecord;
  firstFailedAtMs: number;
  lastFailedAtMs: number;
  lastError: string;
};

export type DualWriteCoordinator = {
  appendEvent: (input: {
    uid: string;
    timelineRecord: DualWriteRecord;
    sessionRecord: DualWriteRecord;
  }) => Promise<DualWriteAppendResult>;
  appendAssistant: (input: {
    uid: string;
    timelineRecord: DualWriteRecord;
    sessionRecord: DualWriteRecord;
  }) => Promise<DualWriteAppendResult>;
  retryPending: () => Promise<DualWriteRetryResult>;
  hasPendingTimelineWrites: (uid?: string) => boolean;
  hasPendingSessionBackfill: (uid?: string) => boolean;
  listPendingSessionBackfillUids: () => string[];
};

const DEFAULT_BACKFILL_WARNING_MS = 5 * 60 * 1000;

function requireUid(uid: string): string {
  const normalized = uid.trim();
  if (!normalized) {
    throw new Error("uid is required");
  }
  return normalized;
}

function requireRecordSessionKey(
  record: DualWriteRecord,
  field: "timelineRecord" | "sessionRecord"
) {
  const value = typeof record.sessionKey === "string" ? record.sessionKey.trim() : "";
  if (!value) {
    throw new Error(`${field}.sessionKey is required`);
  }
  return value;
}

function toReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildPendingWrite(input: {
  uid: string;
  timelineRecord: DualWriteRecord;
  sessionRecord: DualWriteRecord;
  nowMs: number;
  previous?: PendingWrite;
  reason: string;
}): PendingWrite {
  return {
    uid: input.uid,
    timelineRecord: input.timelineRecord,
    sessionRecord: input.sessionRecord,
    firstFailedAtMs: input.previous?.firstFailedAtMs ?? input.nowMs,
    lastFailedAtMs: input.nowMs,
    lastError: input.reason,
  };
}

async function appendSessionAndQueueOnError(params: {
  uid: string;
  nowMs: number;
  timelineRecord: DualWriteRecord;
  sessionRecord: DualWriteRecord;
  appendSessionRecord: (record: DualWriteRecord) => Promise<void>;
  pendingSessionBackfill: Map<string, PendingWrite>;
}): Promise<DualWriteAppendResult> {
  try {
    await params.appendSessionRecord(params.sessionRecord);
    params.pendingSessionBackfill.delete(params.uid);
    return { status: "committed" };
  } catch (error) {
    const reason = toReason(error);
    const previous = params.pendingSessionBackfill.get(params.uid);
    params.pendingSessionBackfill.set(
      params.uid,
      buildPendingWrite({
        uid: params.uid,
        timelineRecord: params.timelineRecord,
        sessionRecord: params.sessionRecord,
        nowMs: params.nowMs,
        previous,
        reason,
      })
    );
    return { status: "pending-session-backfill" };
  }
}

export function createDualWriteCoordinator(deps: DualWriteCoordinatorDeps): DualWriteCoordinator {
  const nowMs = deps.nowMs ?? (() => Date.now());
  const backfillWarningMs = Math.max(
    1,
    Math.floor(deps.backfillWarningMs ?? DEFAULT_BACKFILL_WARNING_MS)
  );
  const timelineCommittedUids = new Set<string>();
  const sessionCommittedUids = new Set<string>();
  const pendingTimelineWrites = new Map<string, PendingWrite>();
  const pendingSessionBackfill = new Map<string, PendingWrite>();

  const appendPair = async (input: {
    uid: string;
    timelineRecord: DualWriteRecord;
    sessionRecord: DualWriteRecord;
  }): Promise<DualWriteAppendResult> => {
    const uid = requireUid(input.uid);
    const timelineSessionKey = requireRecordSessionKey(input.timelineRecord, "timelineRecord");
    const sessionSessionKey = requireRecordSessionKey(input.sessionRecord, "sessionRecord");
    if (timelineSessionKey !== sessionSessionKey) {
      throw new Error("timelineRecord.sessionKey must match sessionRecord.sessionKey");
    }
    if (sessionCommittedUids.has(uid)) {
      return { status: "committed" };
    }

    if (!timelineCommittedUids.has(uid)) {
      try {
        await deps.appendTimelineRecord(input.timelineRecord);
        timelineCommittedUids.add(uid);
        pendingTimelineWrites.delete(uid);
      } catch (error) {
        const reason = toReason(error);
        const previous = pendingTimelineWrites.get(uid);
        pendingTimelineWrites.set(
          uid,
          buildPendingWrite({
            uid,
            timelineRecord: input.timelineRecord,
            sessionRecord: input.sessionRecord,
            nowMs: nowMs(),
            previous,
            reason,
          })
        );
        return { status: "pending-timeline" };
      }
    }

    const sessionResult = await appendSessionAndQueueOnError({
      uid,
      nowMs: nowMs(),
      timelineRecord: input.timelineRecord,
      sessionRecord: input.sessionRecord,
      appendSessionRecord: deps.appendSessionRecord,
      pendingSessionBackfill,
    });
    if (sessionResult.status === "committed") {
      sessionCommittedUids.add(uid);
    }
    return sessionResult;
  };

  const retryPending = async (): Promise<DualWriteRetryResult> => {
    let timelineRecovered = 0;
    let sessionRecovered = 0;
    const processedSessionUids = new Set<string>();

    for (const [uid, pending] of Array.from(pendingTimelineWrites.entries())) {
      try {
        await deps.appendTimelineRecord(pending.timelineRecord);
        timelineCommittedUids.add(uid);
        pendingTimelineWrites.delete(uid);
        timelineRecovered += 1;

        const sessionResult = await appendSessionAndQueueOnError({
          uid,
          nowMs: nowMs(),
          timelineRecord: pending.timelineRecord,
          sessionRecord: pending.sessionRecord,
          appendSessionRecord: deps.appendSessionRecord,
          pendingSessionBackfill,
        });
        processedSessionUids.add(uid);
        if (sessionResult.status === "committed") {
          sessionCommittedUids.add(uid);
          sessionRecovered += 1;
        }
      } catch (error) {
        const reason = toReason(error);
        pendingTimelineWrites.set(
          uid,
          buildPendingWrite({
            uid,
            timelineRecord: pending.timelineRecord,
            sessionRecord: pending.sessionRecord,
            nowMs: nowMs(),
            previous: pending,
            reason,
          })
        );
      }
    }

    for (const [uid, pending] of Array.from(pendingSessionBackfill.entries())) {
      if (processedSessionUids.has(uid)) {
        continue;
      }
      const result = await appendSessionAndQueueOnError({
        uid,
        nowMs: nowMs(),
        timelineRecord: pending.timelineRecord,
        sessionRecord: pending.sessionRecord,
        appendSessionRecord: deps.appendSessionRecord,
        pendingSessionBackfill,
      });
      if (result.status === "committed") {
        sessionCommittedUids.add(uid);
        sessionRecovered += 1;
        continue;
      }

      const ageMs = nowMs() - pending.firstFailedAtMs;
      if (ageMs >= backfillWarningMs) {
        deps.onWarn?.("dual-write-backfill-stalled", {
          uid,
          ageMs,
          lastError: pending.lastError,
        });
      }
    }

    return {
      timelineRecovered,
      sessionRecovered,
      pendingTimeline: pendingTimelineWrites.size,
      pendingSessionBackfill: pendingSessionBackfill.size,
    };
  };

  return {
    appendEvent: appendPair,
    appendAssistant: appendPair,
    retryPending,
    hasPendingTimelineWrites: (uid) => {
      if (!uid) {
        return pendingTimelineWrites.size > 0;
      }
      return pendingTimelineWrites.has(uid.trim());
    },
    hasPendingSessionBackfill: (uid) => {
      if (!uid) {
        return pendingSessionBackfill.size > 0;
      }
      return pendingSessionBackfill.has(uid.trim());
    },
    listPendingSessionBackfillUids: () => Array.from(pendingSessionBackfill.keys()),
  };
}
