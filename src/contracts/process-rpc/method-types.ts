export const PROCESS_RPC_METHODS = {
  COLLECTOR_INGEST: "collector/ingest",
  DELIVER_ENQUEUE: "deliver/enqueue",
  DELIVER_COMPLETED: "deliver/completed",
} as const;

export type ProcessRpcMethod = (typeof PROCESS_RPC_METHODS)[keyof typeof PROCESS_RPC_METHODS];

export interface AcceptedResponse {
  messageId: string;
  status: "accepted";
  acceptedAt: string;
}

export type CompletionStatus = "completed" | "failed";

export interface CompletionEvent {
  messageId: string;
  status: CompletionStatus;
  finishedAt: string;
  error?: string;
}

export interface CollectorIngestRequest {
  messageId: string;
  dedupeKey: string;
  source: string;
  payload: unknown;
  occurredAt: string;
}

export type CollectorIngestResponse = AcceptedResponse;

export interface DeliverEnqueueRequest {
  messageId: string;
  dedupeKey: string;
  target: string;
  payload: unknown;
  attempt: number;
  maxAttempts: number;
  notBefore?: string;
}

export type DeliverEnqueueResponse = AcceptedResponse;

export type DeliverCompletedNotification = CompletionEvent;
