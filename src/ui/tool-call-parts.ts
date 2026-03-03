import type { ThreadMessageLike } from "@assistant-ui/react";

import type {
  ChatHistoryMessage,
  ChatStreamEvent,
  ToolEventRecord,
} from "../control-plane/contracts/http-api.js";

export type ToolCallPartState = {
  toolCallId: string;
  toolName: string;
  toolStatus: "started" | "completed" | "failed";
  toolInput?: unknown;
  toolOutput?: unknown;
  toolError?: string;
};

type AssistantMessagePart = Exclude<ThreadMessageLike["content"], string>[number];

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function toStableToolName(value: unknown): string {
  const raw = asString(value)?.trim();
  return raw && raw.length > 0 ? raw : "tool";
}

function toStableToolCallId(value: unknown): string | undefined {
  const raw = asString(value)?.trim();
  return raw && raw.length > 0 ? raw : undefined;
}

function statusFromToolRecord(
  value: ToolEventRecord["status"]
): "started" | "completed" | "failed" {
  if (value === "completed") {
    return "completed";
  }
  if (value === "failed") {
    return "failed";
  }
  return "started";
}

function statusRank(value: ToolCallPartState["toolStatus"]): number {
  if (value === "started") {
    return 1;
  }
  return 2;
}

function toJsonText(value: unknown): string {
  if (value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "[unserializable]";
  }
}

function toToolArgsText(input: unknown): string {
  if (input === undefined) {
    return "";
  }

  if (typeof input === "string") {
    return input;
  }

  return toJsonText(input);
}

function toToolResult(state: ToolCallPartState): { result?: unknown; isError?: boolean } {
  if (state.toolStatus === "failed") {
    return {
      result: state.toolOutput ?? state.toolError ?? "tool call failed",
      isError: true,
    };
  }

  if (state.toolStatus === "completed") {
    return {
      result: state.toolOutput,
      isError: false,
    };
  }

  return {};
}

export function mapChatToolEventToState(event: ChatStreamEvent): ToolCallPartState | undefined {
  if (event.toolStatus === undefined) {
    return undefined;
  }

  const toolCallId = toStableToolCallId(event.toolCallId);
  if (toolCallId === undefined) {
    return undefined;
  }

  return {
    toolCallId,
    toolName: toStableToolName(event.toolName),
    toolStatus: event.toolStatus,
    toolInput: event.toolInput,
    toolOutput: event.toolOutput,
    toolError: event.toolError,
  };
}

export function mapToolRecordToState(record: ToolEventRecord): ToolCallPartState {
  return {
    toolCallId: record.toolCallId,
    toolName: toStableToolName(record.title ?? record.kind),
    toolStatus: statusFromToolRecord(record.status),
    toolInput: record.rawInput,
    toolOutput: record.rawOutput,
    toolError: record.error,
  };
}

export function mergeToolCallState(
  current: ToolCallPartState | undefined,
  next: ToolCallPartState
): ToolCallPartState {
  if (current === undefined) {
    return next;
  }

  return {
    toolCallId: current.toolCallId,
    toolName: next.toolName || current.toolName,
    toolStatus:
      statusRank(next.toolStatus) >= statusRank(current.toolStatus)
        ? next.toolStatus
        : current.toolStatus,
    toolInput: next.toolInput ?? current.toolInput,
    toolOutput: next.toolOutput ?? current.toolOutput,
    toolError: next.toolError ?? current.toolError,
  };
}

export function upsertToolCallStates(
  states: readonly ToolCallPartState[],
  next: ToolCallPartState
): ToolCallPartState[] {
  const index = states.findIndex((state) => state.toolCallId === next.toolCallId);
  if (index < 0) {
    return [...states, next];
  }

  const merged = mergeToolCallState(states[index], next);
  const updated = [...states];
  updated[index] = merged;
  return updated;
}

export function toToolCallMessagePart(state: ToolCallPartState): AssistantMessagePart {
  const argsText = toToolArgsText(state.toolInput);
  const result = toToolResult(state);

  return {
    type: "tool-call",
    toolCallId: state.toolCallId,
    toolName: state.toolName,
    argsText,
    result: result.result,
    isError: result.isError,
  };
}

export function buildAssistantMessageContent(input: {
  text: string;
  thinking?: string;
  toolStates: readonly ToolCallPartState[];
}): ThreadMessageLike["content"] {
  const parts: AssistantMessagePart[] = [];

  if (input.thinking && input.thinking.length > 0) {
    parts.push({ type: "reasoning", text: input.thinking });
  }

  if (input.text.length > 0) {
    parts.push({ type: "text", text: input.text });
  }

  for (const state of input.toolStates) {
    parts.push(toToolCallMessagePart(state));
  }

  return parts.length > 0 ? parts : "";
}

function toThreadMessageLike(message: ChatHistoryMessage, index: number): ThreadMessageLike {
  const normalizedRunId = typeof message.runId === "string" ? message.runId.trim() : "";
  const stableId =
    normalizedRunId.length > 0
      ? `${message.role}:${normalizedRunId}`
      : `${message.role}:${message.timestamp}:${index}`;

  return {
    id: stableId,
    role: message.role,
    content: message.content,
    createdAt: new Date(message.timestamp),
  };
}

export function mergeHistoryWithToolEvents(input: {
  messages: ChatHistoryMessage[];
  toolEventsByRun: Record<string, ToolEventRecord[]>;
}): ThreadMessageLike[] {
  return input.messages.map((message, index) => {
    const base = toThreadMessageLike(message, index);
    if (message.role !== "assistant" || !message.runId) {
      return base;
    }

    const records = [...(input.toolEventsByRun[message.runId] ?? [])].sort((a, b) =>
      a.updatedAt.localeCompare(b.updatedAt)
    );
    if (records.length === 0) {
      return base;
    }

    let states: ToolCallPartState[] = [];
    for (const record of records) {
      states = upsertToolCallStates(states, mapToolRecordToState(record));
    }

    return {
      ...base,
      content: buildAssistantMessageContent({
        text: message.content,
        toolStates: states,
      }),
    };
  });
}
