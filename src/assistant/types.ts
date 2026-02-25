export type { NormalizedEvent } from "../core/events.js";

export type SystemEvent = {
  text: string;
  ts: number;
};

export type PiTranscriptLine = {
  type?: string;
  timestamp?: string;
  message?: Record<string, unknown>;
  id?: string;
  [key: string]: unknown;
};

export type SessionTranscriptEvent = {
  sessionKey: string;
  sessionId: string;
  messageId?: string;
  ts: number;
  role: "user" | "assistant" | "system" | "tool" | "other";
  text?: string;
  raw: PiTranscriptLine;
};

export type SessionMessage = {
  role: "user" | "assistant" | "system" | "tool" | "other";
  content: string;
  timestamp: number;
  message?: Record<string, unknown>;
};

export type StreamEvent = {
  runId: string;
  sessionKey: string;
  seq: number;
  state: "delta" | "final" | "aborted" | "error";
  message?: unknown;
  errorMessage?: string;
  usage?: unknown;
  stopReason?: string;
};

export type AgentRunStatus = {
  schema: "adjutant.agent.run-status.v1";
  sessionId: string;
  sessionKey: string;
  runId: string;
  status: "queued" | "running" | "completed" | "failed";
  reason?: string;
  updatedAt: string;
};

export type HeartbeatRunResult =
  | { status: "ran"; durationMs: number; alert?: string; contentHash?: string; modelId?: string }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

export type HeartbeatEventPayload = {
  ts: number;
  status: "sent" | "ok-empty" | "ok-token" | "skipped" | "failed";
  reason?: string;
  to?: string;
  channel?: string;
  accountId?: string;
  preview?: string;
  durationMs?: number;
  hasMedia?: boolean;
  silent?: boolean;
  indicatorType?: "ok" | "alert" | "error";
};

export type HeartbeatRunRecord = {
  schema: "adjutant.heartbeat.result.v1";
  runAt: string;
  sessionId?: string;
  sessionKey?: string;
  result: HeartbeatRunResult;
  triggerReason?: string;
  modelId?: string;
  preview?: string;
  eventStatus?: HeartbeatEventPayload["status"];
  eventReason?: string;
};
