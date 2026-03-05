export const HEARTBEAT_RESULT_SCHEMA_V1 = "adjutant.heartbeat.result.v1";
export const HEARTBEAT_TOOL_NAME = "report_heartbeat_status";

export const HEARTBEAT_RUN_STATUSES = ["ran", "skipped", "failed"] as const;
export type HeartbeatRunStatus = (typeof HEARTBEAT_RUN_STATUSES)[number];

export const HEARTBEAT_EVENT_STATUSES = [
  "sent",
  "ok-token",
  "ok-empty",
  "skipped",
  "failed",
] as const;
export type HeartbeatEventStatus = (typeof HEARTBEAT_EVENT_STATUSES)[number];

export const HEARTBEAT_REPORT_STATUSES = [
  "no_action_needed",
  "needs_attention",
  "task_completed",
] as const;
export type HeartbeatReportStatus = (typeof HEARTBEAT_REPORT_STATUSES)[number];

export type ReportHeartbeatStatusPayload = {
  status: HeartbeatReportStatus;
  notify?: boolean;
  reason?: string;
};

export type HeartbeatRunResultV1 = {
  schema: typeof HEARTBEAT_RESULT_SCHEMA_V1;
  status: HeartbeatRunStatus;
  event: {
    status: HeartbeatEventStatus;
    reason?: string;
  };
  ts: string;
  runId?: string;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isIsoLikeTimestamp(value: unknown): value is string {
  return isString(value) && value.includes("T");
}

function isHeartbeatRunStatus(value: unknown): value is HeartbeatRunStatus {
  return HEARTBEAT_RUN_STATUSES.some((candidate) => candidate === value);
}

function isHeartbeatEventStatus(value: unknown): value is HeartbeatEventStatus {
  return HEARTBEAT_EVENT_STATUSES.some((candidate) => candidate === value);
}

function isHeartbeatReportStatus(value: unknown): value is HeartbeatReportStatus {
  return HEARTBEAT_REPORT_STATUSES.some((candidate) => candidate === value);
}

export function validateReportHeartbeatStatusPayload(
  value: unknown
): value is ReportHeartbeatStatusPayload {
  if (!isObject(value)) {
    return false;
  }
  if (!isHeartbeatReportStatus(value.status)) {
    return false;
  }
  if (value.notify !== undefined && !isBoolean(value.notify)) {
    return false;
  }
  return value.reason === undefined || isString(value.reason);
}

export function validateHeartbeatRunResultV1(value: unknown): value is HeartbeatRunResultV1 {
  if (!isObject(value)) {
    return false;
  }
  if (value.schema !== HEARTBEAT_RESULT_SCHEMA_V1) {
    return false;
  }
  if (!isHeartbeatRunStatus(value.status)) {
    return false;
  }
  if (!isIsoLikeTimestamp(value.ts)) {
    return false;
  }
  if (value.runId !== undefined && !isString(value.runId)) {
    return false;
  }
  if (!isObject(value.event)) {
    return false;
  }
  if (!isHeartbeatEventStatus(value.event.status)) {
    return false;
  }
  return value.event.reason === undefined || isString(value.event.reason);
}
