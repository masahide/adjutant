export type PostChatMessageRequest = {
  message: string;
  sessionKey: string;
  idempotencyKey: string;
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
  | { kind: "new"; runId: string }
  | { kind: "existing"; runId: string; status: "in_flight" | "ok" | "error" };
