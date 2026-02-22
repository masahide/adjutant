import { readFile } from "node:fs/promises";
import { parseTimelineLines } from "./pending-flusher.js";

export type HeartbeatTimelineRecord = {
  recordType?: unknown;
  role?: unknown;
  kind?: unknown;
  uid?: unknown;
  ts?: unknown;
  [key: string]: unknown;
};

export type HeartbeatScanInput = {
  records: HeartbeatTimelineRecord[];
  nowMs: number;
  heartbeatStaleMs: number;
  pendingSessionBackfillUids?: Iterable<string>;
};

export type HeartbeatScanResult = {
  shouldRun: boolean;
  reason: "no-stale-post" | "stale-post-found" | "pending-session-backfill";
  stalePostUids: string[];
  blockedPendingUids: string[];
  boundaryFound: boolean;
  inspectedRecords: number;
};

export type TimelineReadOptions = {
  timelinePath: string;
};

function normalizeString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }
  return normalized;
}

function parseTsMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const fromNumeric = Number(value);
    if (Number.isFinite(fromNumeric)) {
      return fromNumeric;
    }
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function isBoundaryRecord(record: HeartbeatTimelineRecord): boolean {
  const role = normalizeString(record.role)?.toLowerCase();
  const recordType = normalizeString(record.recordType)?.toLowerCase();
  return role === "assistant" || role === "tool" || recordType === "action";
}

function isStaleUserPost(params: {
  record: HeartbeatTimelineRecord;
  nowMs: number;
  heartbeatStaleMs: number;
}): boolean {
  const recordType = normalizeString(params.record.recordType)?.toLowerCase();
  const role = normalizeString(params.record.role)?.toLowerCase();
  const kind = normalizeString(params.record.kind)?.toLowerCase();
  if (recordType !== "event" || role !== "user" || kind !== "post") {
    return false;
  }

  const tsMs = parseTsMs(params.record.ts);
  if (tsMs === null) {
    return false;
  }
  return params.nowMs - tsMs >= params.heartbeatStaleMs;
}

export function evaluateHeartbeatScan(input: HeartbeatScanInput): HeartbeatScanResult {
  const pendingSessionBackfillUids = new Set(
    Array.from(input.pendingSessionBackfillUids ?? [])
      .map((uid) => uid.trim())
      .filter(Boolean)
  );

  const stalePostUids: string[] = [];
  const blockedPendingUids: string[] = [];
  let boundaryFound = false;
  let inspectedRecords = 0;

  for (let index = input.records.length - 1; index >= 0; index -= 1) {
    const record = input.records[index] ?? {};
    inspectedRecords += 1;

    if (isBoundaryRecord(record)) {
      boundaryFound = true;
      break;
    }

    if (
      !isStaleUserPost({ record, nowMs: input.nowMs, heartbeatStaleMs: input.heartbeatStaleMs })
    ) {
      continue;
    }

    const uid = normalizeString(record.uid);
    if (uid && pendingSessionBackfillUids.has(uid)) {
      blockedPendingUids.push(uid);
      continue;
    }
    stalePostUids.push(uid ?? `unknown-${index}`);
  }

  if (stalePostUids.length > 0) {
    return {
      shouldRun: true,
      reason: "stale-post-found",
      stalePostUids,
      blockedPendingUids,
      boundaryFound,
      inspectedRecords,
    };
  }
  if (blockedPendingUids.length > 0) {
    return {
      shouldRun: false,
      reason: "pending-session-backfill",
      stalePostUids,
      blockedPendingUids,
      boundaryFound,
      inspectedRecords,
    };
  }
  return {
    shouldRun: false,
    reason: "no-stale-post",
    stalePostUids,
    blockedPendingUids,
    boundaryFound,
    inspectedRecords,
  };
}

export function parseTimelineJsonl(raw: string): HeartbeatTimelineRecord[] {
  return parseTimelineLines(raw)
    .map((line) => {
      const record = line.record;
      if (!record || typeof record !== "object" || Array.isArray(record)) {
        return null;
      }
      return record as HeartbeatTimelineRecord;
    })
    .filter((record): record is HeartbeatTimelineRecord => Boolean(record));
}

export async function readTimelineJsonl(
  opts: TimelineReadOptions
): Promise<HeartbeatTimelineRecord[]> {
  const raw = await readFile(opts.timelinePath, "utf8");
  return parseTimelineJsonl(raw);
}

export async function scanHeartbeatTimeline(opts: {
  timelinePath: string;
  nowMs: number;
  heartbeatStaleMs: number;
  pendingSessionBackfillUids?: Iterable<string>;
}): Promise<HeartbeatScanResult> {
  const records = await readTimelineJsonl({ timelinePath: opts.timelinePath });
  return evaluateHeartbeatScan({
    records,
    nowMs: opts.nowMs,
    heartbeatStaleMs: opts.heartbeatStaleMs,
    pendingSessionBackfillUids: opts.pendingSessionBackfillUids,
  });
}
