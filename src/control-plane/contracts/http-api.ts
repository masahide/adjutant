import type { PendingPermission } from "../acp/permission-registry.js";

export type CommandRequest = {
  sessionKey: string;
  message: string;
  runId?: string;
  idempotencyKey?: string;
};

export type AcceptedResponse = {
  messageId: string;
  status: "accepted";
  acceptedAt: string;
  runId: string;
  sessionRecovered?: boolean;
  sessionRecoveryMode?: SessionRecoveryMode;
  sessionRecoveryReason?: string;
};

export const STREAM_EVENT_TYPES = [
  "run/accepted",
  "run/update",
  "run/completed",
  "run/failed",
  "permission/requested",
  "permission/resolved",
] as const;

export type StreamEventType = (typeof STREAM_EVENT_TYPES)[number];

export type StreamEvent<TPayload = Record<string, unknown>> = {
  event: StreamEventType;
  data: TPayload;
};

export type RunStatus = "accepted" | "running" | "completed" | "failed" | "cancelled";
export type SessionRecoveryMode =
  | "in_memory"
  | "session_load"
  | "new_session"
  | "fallback_new_session";

export type RunSummary = {
  runId: string;
  sessionKey: string;
  sessionId?: string;
  status: RunStatus;
  acceptedAt: string;
  startedAt?: string;
  finishedAt?: string;
  stopReason?: string;
  errorCode?: string;
  errorMessage?: string;
  sessionRecovered?: boolean;
  sessionRecoveryMode?: SessionRecoveryMode;
  sessionRecoveryReason?: string;
};

export type PermissionSummary = {
  requestId: string;
  sessionId: string;
  runId?: string;
  toolCallId?: string;
  title: string;
  requestedAt: string;
};

export type ToolEventRecord = {
  runId: string;
  sessionId: string;
  toolCallId: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  title?: string;
  kind?: string;
  updatedAt: string;
};

export type SnapshotResponse = {
  runs: RunSummary[];
  toolEventsByRun: Record<string, ToolEventRecord[]>;
  pendingPermissions: PermissionSummary[];
};

export function toPermissionSummary(input: PendingPermission): PermissionSummary {
  return {
    requestId: input.requestId,
    sessionId: input.sessionId,
    runId: input.runId,
    toolCallId: input.toolCallId,
    title: input.title,
    requestedAt: input.createdAt,
  };
}
