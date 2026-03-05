import { isNormalizedEvent, type NormalizedEvent } from "../../core/events.js";

export const TIMELINE_RECORD_SCHEMA_V1_5 = "adjutant.timeline.record.v1.5";
export const WATERMARKS_SCHEMA_V1 = "adjutant.watermarks.v1";

export const TIMELINE_RECORD_TYPES = ["event", "action"] as const;
export type TimelineRecordType = (typeof TIMELINE_RECORD_TYPES)[number];

export const TIMELINE_ACTION_TYPES = [
  "assistant_final",
  "assistant_aborted",
  "assistant_error",
] as const;
export type TimelineActionType = (typeof TIMELINE_ACTION_TYPES)[number];

export type TimelineRecordBaseV1_5 = {
  schema: typeof TIMELINE_RECORD_SCHEMA_V1_5;
  recordType: TimelineRecordType;
  sessionKey: string;
  uid: string;
  ts: string;
  loggedAt: string;
  timelineOffset?: number;
};

export type TimelineEventRecordV1_5 = TimelineRecordBaseV1_5 & {
  recordType: "event";
  event: NormalizedEvent;
};

export type TimelineActionRecordV1_5 = TimelineRecordBaseV1_5 & {
  recordType: "action";
  actionType: TimelineActionType;
  runId?: string;
};

export type TimelineRecordV1_5 = TimelineEventRecordV1_5 | TimelineActionRecordV1_5;

export type WatermarkSessionState = {
  handled: {
    lastHandledOffset: number;
  };
  open: {
    openPostCount: number;
    oldestOpenAt?: string;
    oldestActor?: string;
  };
};

export type WatermarksV1 = {
  schema: typeof WATERMARKS_SCHEMA_V1;
  scan: {
    lastScannedOffset: number;
    lastGoodOffset: number;
  };
  sessions: Record<string, WatermarkSessionState>;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isIsoLikeTimestamp(value: unknown): value is string {
  return isString(value) && value.includes("T");
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isTimelineActionType(value: unknown): value is TimelineActionType {
  return TIMELINE_ACTION_TYPES.some((candidate) => candidate === value);
}

export function validateTimelineRecordV1_5(value: unknown): value is TimelineRecordV1_5 {
  if (!isObject(value)) {
    return false;
  }
  if (value.schema !== TIMELINE_RECORD_SCHEMA_V1_5) {
    return false;
  }
  if (
    (value.recordType !== "event" && value.recordType !== "action") ||
    !isString(value.sessionKey) ||
    value.sessionKey.length === 0 ||
    !isString(value.uid) ||
    value.uid.length === 0 ||
    !isIsoLikeTimestamp(value.ts) ||
    !isIsoLikeTimestamp(value.loggedAt)
  ) {
    return false;
  }
  if (value.timelineOffset !== undefined && !isNonNegativeFinite(value.timelineOffset)) {
    return false;
  }

  if (value.recordType === "event") {
    return isNormalizedEvent(value.event);
  }

  if (!isTimelineActionType(value.actionType)) {
    return false;
  }
  return value.runId === undefined || isString(value.runId);
}

export function validateWatermarksV1(value: unknown): value is WatermarksV1 {
  if (!isObject(value)) {
    return false;
  }
  if (value.schema !== WATERMARKS_SCHEMA_V1) {
    return false;
  }
  if (!isObject(value.scan) || !isObject(value.sessions)) {
    return false;
  }
  if (!isNonNegativeFinite(value.scan.lastScannedOffset)) {
    return false;
  }
  if (!isNonNegativeFinite(value.scan.lastGoodOffset)) {
    return false;
  }

  for (const session of Object.values(value.sessions)) {
    if (!isObject(session)) {
      return false;
    }
    if (!isObject(session.handled) || !isObject(session.open)) {
      return false;
    }
    if (!isNonNegativeFinite(session.handled.lastHandledOffset)) {
      return false;
    }
    if (!isNonNegativeFinite(session.open.openPostCount)) {
      return false;
    }
    if (session.open.oldestOpenAt !== undefined && !isIsoLikeTimestamp(session.open.oldestOpenAt)) {
      return false;
    }
    if (session.open.oldestActor !== undefined && !isString(session.open.oldestActor)) {
      return false;
    }
  }

  return true;
}
