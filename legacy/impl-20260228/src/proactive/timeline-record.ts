import { TIMELINE_RECORD_SCHEMA_V1_5, type TimelineRecordV1_5 } from "./types.js";

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed;
}

function assertIso8601(value: unknown, field: string): string {
  const normalized = asNonEmptyString(value);
  if (!normalized || !Number.isFinite(Date.parse(normalized))) {
    throw new Error(`timeline record ${field} must be a valid ISO8601 string`);
  }
  return normalized;
}

function assertOptionalString(
  value: unknown,
  field: "kind" | "uid" | "actor" | "runId"
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = asNonEmptyString(value);
  if (!normalized) {
    throw new Error(`timeline record ${field} must be a non-empty string`);
  }
  return normalized;
}

export function validateTimelineRecordV1_5(value: unknown): TimelineRecordV1_5 {
  const record = asObject(value);
  if (!record) {
    throw new Error("timeline record must be an object");
  }

  if (record.schema !== TIMELINE_RECORD_SCHEMA_V1_5) {
    throw new Error(`timeline record schema must be ${TIMELINE_RECORD_SCHEMA_V1_5}`);
  }

  const recordType = asNonEmptyString(record.recordType);
  if (recordType !== "event" && recordType !== "action") {
    throw new Error("timeline record recordType must be event or action");
  }

  const role = asNonEmptyString(record.role);
  if (role !== "user" && role !== "assistant" && role !== "tool") {
    throw new Error("timeline record role must be user/assistant/tool");
  }

  const sessionKey = asNonEmptyString(record.sessionKey);
  if (!sessionKey) {
    throw new Error("timeline record sessionKey is required");
  }

  const ts = assertIso8601(record.ts, "ts");
  const loggedAt = assertIso8601(record.loggedAt, "loggedAt");
  const kind = assertOptionalString(record.kind, "kind");
  const uid = assertOptionalString(record.uid, "uid");
  const actor = assertOptionalString(record.actor, "actor");
  const runId = assertOptionalString(record.runId, "runId");

  let actionType: TimelineRecordV1_5["actionType"];
  if (record.actionType !== undefined) {
    const normalized = asNonEmptyString(record.actionType);
    if (
      normalized !== "assistant_final" &&
      normalized !== "assistant_aborted" &&
      normalized !== "assistant_error"
    ) {
      throw new Error("timeline record actionType is invalid");
    }
    actionType = normalized;
  }

  if (recordType === "action" && !actionType) {
    throw new Error("timeline action record requires actionType");
  }

  return {
    ...record,
    schema: TIMELINE_RECORD_SCHEMA_V1_5,
    recordType,
    role,
    sessionKey,
    ts,
    loggedAt,
    kind,
    uid,
    actor,
    actionType,
    runId,
  };
}

export function isTimelineRecordV1_5(value: unknown): value is TimelineRecordV1_5 {
  try {
    validateTimelineRecordV1_5(value);
    return true;
  } catch {
    return false;
  }
}

export function createTimelineRecordV1_5(
  input: Omit<TimelineRecordV1_5, "schema" | "loggedAt"> & { loggedAt?: string }
): TimelineRecordV1_5 {
  return validateTimelineRecordV1_5({
    ...input,
    schema: TIMELINE_RECORD_SCHEMA_V1_5,
    loggedAt: input.loggedAt ?? new Date().toISOString(),
  });
}
