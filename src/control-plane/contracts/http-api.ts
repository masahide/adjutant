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

export const CHAT_STREAM_STATES = ["delta", "final", "aborted", "error"] as const;
export type ChatStreamState = (typeof CHAT_STREAM_STATES)[number];

export type ChatStreamEvent = {
  seq: number;
  state: ChatStreamState;
  runId: string;
  sessionKey: string;
  message?: string;
  thinking?: string;
  errorMessage?: string;
  toolCallId?: string;
  toolName?: string;
  toolStatus?: "started" | "completed" | "failed";
  toolArgs?: string;
  toolResult?: string;
  permissionRequest?: {
    requestId: string;
    title: string;
    toolCallId?: string;
  };
  permissionResolved?: {
    requestId: string;
    outcome: "allow" | "deny" | "cancelled";
  };
};

export type PostChatMessageRequest = {
  message: string;
  sessionKey: string;
  idempotencyKey: string;
};

export type PostChatMessageResponse = {
  // AcceptedResponse の公開サブセット。内部では AcceptedResponse を生成し、
  // /api/chat/messages では runId/status のみを返す。
  runId: string;
  status: "accepted";
};

export type PostChatAbortRequest = {
  sessionKey: string;
  runId?: string;
};

// v1 は 200 OK + 空オブジェクト応答を契約とする。
export type PostChatAbortResponse = Record<string, never>;

export type ChatHistoryContentPart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | {
      type: "tool-call";
      toolCallId: string;
      toolName: string;
      argsText?: string;
      result?: unknown;
      isError?: boolean;
    };

export type ChatHistoryMessage = {
  role: "user" | "assistant";
  content: string | ChatHistoryContentPart[];
  runId?: string;
  toolCount?: number;
  timestamp: string;
};

export type GetChatHistoryResponse = {
  messages: ChatHistoryMessage[];
};

export type ChatRunAuditToolSummary = {
  toolName: string;
  toolCallId?: string;
  status?: "ok" | "error";
  args?: unknown;
  resultSummary?: unknown;
  error?: string;
  startedAt?: string;
  endedAt?: string;
};

export type GetChatRunAuditResponse = {
  runId: string;
  sessionKey?: string;
  runEnded: boolean;
  runStatus?: "ok" | "aborted" | "error";
  stopReason?: string;
  error?: string;
  tools: ChatRunAuditToolSummary[];
  summaryBatches: Array<{
    status: "ok" | "error";
    processedSessions?: number;
    writtenEntries?: number;
    skippedEntries?: number;
    warnings?: number;
    error?: string;
    ts?: string;
  }>;
};

export type ThreadRecord = {
  threadId: string;
  title: string;
  archived: boolean;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
};

export type CreateThreadRequest = {
  title?: string;
};

export type UpdateThreadRequest = {
  title?: string;
  archived?: boolean;
  // 禁止: threadId, sessionKey, createdAt, isDefault など。
  // これらが含まれる場合は 400 INVALID_REQUEST とする。
};

export type ListThreadsResponse = ThreadRecord[];
export type CreateThreadResponse = ThreadRecord;
export type GetThreadResponse = ThreadRecord;
export type UpdateThreadResponse = ThreadRecord;

export type ThreadSnapshotResponse = SnapshotResponse & {
  thread: ThreadRecord;
};

export type PostPermissionResolveRequest = {
  requestId: string;
  outcome: "allow" | "deny";
};

export type PostPermissionResolveResponse = Record<string, never>;

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
