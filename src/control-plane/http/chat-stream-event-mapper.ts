import type { PermissionGatewayEvent } from "../acp/permission-gateway.js";
import type { ChatStreamEvent, RunFailureSummary } from "./run-event-buffer.js";

type SessionUpdateRecord = Record<string, unknown>;

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return value;
}

function normalizeToolStatus(value: unknown): "started" | "completed" | "failed" | undefined {
  if (value === "failed") {
    return "failed";
  }
  if (value === "completed") {
    return "completed";
  }
  if (value === "pending" || value === "in_progress") {
    return "started";
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

export function mapSessionUpdateToChatStreamEvent(input: {
  runId: string;
  sessionKey: string;
  update: SessionUpdateRecord;
}): Omit<ChatStreamEvent, "seq"> | undefined {
  const type = asString(input.update.sessionUpdate);
  if (type === "agent_message_chunk") {
    const content = asRecord(input.update.content);
    const message = asString(content?.text) ?? "";
    return {
      state: "delta",
      runId: input.runId,
      sessionKey: input.sessionKey,
      message,
    };
  }

  if (type === "agent_thinking_chunk") {
    const content = asRecord(input.update.content);
    const thinking = asString(content?.text) ?? "";
    return {
      state: "delta",
      runId: input.runId,
      sessionKey: input.sessionKey,
      thinking,
    };
  }

  if (type === "tool_call") {
    const toolName = asString(input.update.title) ?? asString(input.update.kind) ?? "tool";
    return {
      state: "delta",
      runId: input.runId,
      sessionKey: input.sessionKey,
      toolCallId: asString(input.update.toolCallId),
      toolName,
      toolStatus: "started",
    };
  }

  if (type === "tool_call_update") {
    const status = normalizeToolStatus(input.update.status);
    if (status === undefined) {
      return undefined;
    }
    const toolName = asString(input.update.title) ?? asString(input.update.kind) ?? "tool";
    return {
      state: "delta",
      runId: input.runId,
      sessionKey: input.sessionKey,
      toolCallId: asString(input.update.toolCallId),
      toolName,
      toolStatus: status,
    };
  }

  return undefined;
}

export function mapPromptResultToChatStreamEvent(input: {
  runId: string;
  sessionKey: string;
  text: string;
}): Omit<ChatStreamEvent, "seq"> {
  return {
    state: "final",
    runId: input.runId,
    sessionKey: input.sessionKey,
    message: input.text,
  };
}

export function mapRunFailureToChatStreamEvent(input: {
  runId: string;
  sessionKey: string;
  summary: RunFailureSummary;
}): Omit<ChatStreamEvent, "seq"> {
  return {
    state: "error",
    runId: input.runId,
    sessionKey: input.sessionKey,
    errorMessage: `${input.summary.errorCode}: ${input.summary.errorMessage}`,
  };
}

export function mapPermissionEventToChatStreamEvent(input: {
  runId: string;
  sessionKey: string;
  event: PermissionGatewayEvent;
}): Omit<ChatStreamEvent, "seq"> | undefined {
  const requestId = asString(input.event.payload.requestId);
  if (requestId === undefined) {
    return undefined;
  }

  if (input.event.type === "permission/requested") {
    const title = asString(input.event.payload.title) ?? "Permission Request";
    return {
      state: "delta",
      runId: input.runId,
      sessionKey: input.sessionKey,
      permissionRequest: {
        requestId,
        title,
        toolCallId: asString(input.event.payload.toolCallId),
      },
    };
  }

  const outcome = input.event.payload.outcome;
  if (outcome !== "allow" && outcome !== "deny" && outcome !== "cancelled") {
    return undefined;
  }

  return {
    state: "delta",
    runId: input.runId,
    sessionKey: input.sessionKey,
    permissionResolved: {
      requestId,
      outcome,
    },
  };
}

export function mapAbortToChatStreamEvent(input: {
  runId: string;
  sessionKey: string;
}): Omit<ChatStreamEvent, "seq"> {
  return {
    state: "aborted",
    runId: input.runId,
    sessionKey: input.sessionKey,
  };
}
