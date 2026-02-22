export type PostChatMessageRequest = {
  message: string;
  sessionKey: string;
  idempotencyKey: string;
  origin?: "user" | "pipeline" | "system";
  originSessionKey?: string;
  pipelineSource?: "dm" | "group" | "channel" | "flusher";
  clientMessageId?: string;
};

export type PostChatMessageResponse = {
  runId: string;
  status: "started" | "in_flight" | "ok" | "error";
  summary?: string;
};

export type PostChatAbortRequest = {
  sessionKey: string;
  runId?: string;
};

export type PostChatAbortResponse = {
  ok: boolean;
  aborted: number;
  runIds: string[];
};

export type DedupResult =
  | { kind: "new"; runId: string; storeKey: string }
  | { kind: "existing"; runId: string; storeKey: string; status: "in_flight" | "ok" | "error" }
  | { kind: "conflict"; runId: string; storeKey: string; status: "in_flight" | "ok" | "error" };
