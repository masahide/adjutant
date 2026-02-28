import { ACP_CLIENT_METHODS } from "../contracts/acp/method-types.js";
import type { ClientNotification } from "../contracts/acp/rpc-types.js";
import type { AcpStopReason } from "./stop-reason.js";

export interface ContentText {
  type: "text";
  text: string;
}

export interface AgentMessageChunkUpdate {
  sessionUpdate: "agent_message_chunk";
  content: ContentText;
}

export interface ToolCallContent {
  type: "content";
  content: ContentText;
}

export type ToolKind = "read" | "edit" | "execute" | "search";
export type ToolStatus = "pending" | "in_progress" | "completed" | "failed";

export interface ToolCallStartUpdate {
  sessionUpdate: "tool_call";
  toolCallId: string;
  title: string;
  kind?: ToolKind;
  status?: ToolStatus;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: ToolCallContent[];
}

export interface ToolCallProgressUpdate {
  sessionUpdate: "tool_call_update";
  toolCallId: string;
  title?: string;
  kind?: ToolKind;
  status?: ToolStatus;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: ToolCallContent[];
}

export interface PlanEntry {
  step: string;
  status: "pending" | "in_progress" | "completed";
}

export interface PlanUpdate {
  sessionUpdate: "plan";
  entries: PlanEntry[];
}

export interface CurrentModeUpdate {
  sessionUpdate: "current_mode_update";
  currentModeId: string;
}

export interface StopReasonUpdate {
  sessionUpdate: "agent_thought_chunk";
  content: ContentText;
  stopReason: AcpStopReason;
}

export type ProjectedSessionUpdate =
  | AgentMessageChunkUpdate
  | ToolCallStartUpdate
  | ToolCallProgressUpdate
  | PlanUpdate
  | CurrentModeUpdate
  | StopReasonUpdate;

export function toSessionUpdateNotification(
  sessionId: string,
  update: ProjectedSessionUpdate
): ClientNotification {
  return {
    jsonrpc: "2.0",
    method: ACP_CLIENT_METHODS.SESSION_UPDATE,
    params: {
      sessionId,
      update: update as unknown as Record<string, unknown>,
    },
  };
}

export function projectAgentMessageChunk(delta: string): AgentMessageChunkUpdate {
  return {
    sessionUpdate: "agent_message_chunk",
    content: {
      type: "text",
      text: delta,
    },
  };
}

export function projectPlan(entries: PlanEntry[]): PlanUpdate {
  return {
    sessionUpdate: "plan",
    entries,
  };
}

export function projectCurrentMode(modeId: string): CurrentModeUpdate {
  return {
    sessionUpdate: "current_mode_update",
    currentModeId: modeId,
  };
}

export function projectTerminalRecord(record: {
  actionType: string;
  status?: "pending-timeline" | "recorded";
  timelineOffset?: number;
  ts?: string;
  runId: string;
}): ToolCallProgressUpdate {
  return {
    sessionUpdate: "tool_call_update",
    toolCallId: `terminal:${record.runId}`,
    title: `terminal:${record.actionType}`,
    kind: "execute",
    status: record.status === "pending-timeline" ? "in_progress" : "completed",
    rawOutput: {
      timelineOffset: record.timelineOffset,
      ts: record.ts,
      status: record.status,
    },
  };
}
