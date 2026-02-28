import type { CompactionEventTracker } from "./compaction-runtime.js";
import {
  auditMessageBind,
  auditToolEnd,
  auditToolStart,
  type AgentAuditScope,
} from "./agent-audit.js";

type UnknownRecord = Record<string, unknown>;

type AgentEventSubscriptionSession = {
  subscribe: (listener: (event: unknown) => void) => () => void;
};

type AgentEventSubscriberRuntime = {
  appendDailyMemory: (
    content: string,
    options: {
      workspaceDir: string;
      timezone: string;
      auditScope?: AgentAuditScope;
    }
  ) => Promise<void>;
  updateLongTermMemory: (
    content: string,
    options: {
      workspaceDir: string;
      timezone: string;
      auditScope?: AgentAuditScope;
    }
  ) => Promise<void>;
};

export type AgentEventSubscriberOptions = {
  session: AgentEventSubscriptionSession;
  runtime: AgentEventSubscriberRuntime;
  memoryWriteEnabled: boolean;
  workspaceDir: string;
  timezone: string;
  auditScope: AgentAuditScope;
  compactionTracker: CompactionEventTracker;
  isSilentTurn: () => boolean;
  onTextDelta?: (delta: string) => void;
  onToolCall?: (name: string, params: unknown) => void;
};

export type AgentEventToolCall = { name: string; result: unknown };

export type AgentEventToolDetail = {
  toolName: string;
  toolCallId?: string;
  status?: "ok" | "error";
  durationMs?: number;
  startedAt?: string;
  endedAt: string;
  args?: unknown;
  resultSummary?: unknown;
  error?: string;
};

export type AgentEventSubscription = {
  unsubscribe: () => void;
  output: { text: string };
  toolCalls: AgentEventToolCall[];
  toolDetails: AgentEventToolDetail[];
  lastAssistantMessageId?: string;
  memoryWriteTasks: Promise<void>[];
  waitForSettledMemoryWrites: () => Promise<void>;
};

function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as UnknownRecord;
}

function tryGetTextDelta(event: unknown): string | null {
  const top = asRecord(event);
  if (!top || top.type !== "message_update") {
    return null;
  }
  const assistantMessageEvent = asRecord(top.assistantMessageEvent);
  if (!assistantMessageEvent || assistantMessageEvent.type !== "text_delta") {
    return null;
  }
  const delta = assistantMessageEvent.delta;
  return typeof delta === "string" ? delta : null;
}

function resolveToolCallId(record: UnknownRecord): string | undefined {
  const candidates = [record.toolCallId, record.toolExecutionId, record.callId, record.id];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate;
    }
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return String(candidate);
    }
  }
  return undefined;
}

function tryGetToolCall(
  event: unknown
): { name: string; args: unknown; toolCallId?: string } | null {
  const top = asRecord(event);
  if (!top || top.type !== "tool_execution_start") {
    return null;
  }
  const toolName = top.toolName;
  if (typeof toolName !== "string") {
    return null;
  }
  return {
    name: toolName,
    args: top.args,
    toolCallId: resolveToolCallId(top),
  };
}

function tryGetToolResult(event: unknown): {
  name: string;
  result: unknown;
  toolCallId?: string;
  status: "ok" | "error";
  error?: string;
} | null {
  const top = asRecord(event);
  if (!top || top.type !== "tool_execution_end") {
    return null;
  }
  const toolName = top.toolName;
  if (typeof toolName !== "string") {
    return null;
  }
  const status =
    top.success === false || top.status === "error" || top.error !== undefined ? "error" : "ok";
  const error = typeof top.error === "string" ? top.error : undefined;
  return {
    name: toolName,
    result: top.result,
    toolCallId: resolveToolCallId(top),
    status,
    error,
  };
}

function tryGetMessageBinding(
  event: unknown
): { messageId: string; role: "user" | "assistant" } | null {
  const top = asRecord(event);
  if (!top || top.type !== "message_end") {
    return null;
  }

  const message = asRecord(top.message);
  if (!message) {
    return null;
  }
  const role = message.role;
  if (role !== "user" && role !== "assistant") {
    return null;
  }
  const messageId = typeof message.id === "string" ? message.id.trim() : "";
  if (!messageId) {
    return null;
  }
  return { messageId, role };
}

function parseMemoryWriteArgs(
  args: unknown
): { scope: "daily" | "long-term"; content: string } | null {
  const record = asRecord(args);
  if (!record) {
    return null;
  }
  const rawContent =
    typeof record.content === "string"
      ? record.content
      : typeof record.text === "string"
        ? record.text
        : "";
  const content = rawContent.trim();
  if (!content) {
    return null;
  }

  const rawScope =
    typeof record.scope === "string"
      ? record.scope.trim().toLowerCase()
      : typeof record.target === "string"
        ? record.target.trim().toLowerCase()
        : "daily";
  if (rawScope === "long-term" || rawScope === "longterm" || rawScope === "memory") {
    return { scope: "long-term", content };
  }
  return { scope: "daily", content };
}

type ToolStartSnapshot = {
  toolName: string;
  toolCallId?: string;
  args?: unknown;
  startedAtMs: number;
};

function pushToolStart(
  snapshots: Map<string, ToolStartSnapshot[]>,
  key: string,
  snapshot: ToolStartSnapshot
): void {
  const queue = snapshots.get(key);
  if (queue) {
    queue.push(snapshot);
    return;
  }
  snapshots.set(key, [snapshot]);
}

function shiftToolStart(
  snapshots: Map<string, ToolStartSnapshot[]>,
  key: string
): ToolStartSnapshot | undefined {
  const queue = snapshots.get(key);
  if (!queue || queue.length === 0) {
    return undefined;
  }
  const next = queue.shift();
  if (queue.length === 0) {
    snapshots.delete(key);
  }
  return next;
}

export function createAgentEventSubscriber(
  options: AgentEventSubscriberOptions
): AgentEventSubscription {
  const output = { text: "" };
  const toolCalls: AgentEventToolCall[] = [];
  const toolDetails: AgentEventToolDetail[] = [];
  const memoryWriteTasks: Promise<void>[] = [];
  const toolStarts = new Map<string, ToolStartSnapshot[]>();
  let settledMemoryTaskCount = 0;
  let lastAssistantMessageId: string | undefined;

  const unsubscribe = options.session.subscribe((event) => {
    options.compactionTracker.onEvent(event);

    const messageBinding = tryGetMessageBinding(event);
    if (messageBinding) {
      auditMessageBind({
        scope: options.auditScope,
        messageId: messageBinding.messageId,
        role: messageBinding.role,
      });
      if (messageBinding.role === "assistant") {
        lastAssistantMessageId = messageBinding.messageId;
      }
    }

    const delta = tryGetTextDelta(event);
    if (delta && !options.isSilentTurn()) {
      output.text += delta;
      options.onTextDelta?.(delta);
    }

    const toolCall = tryGetToolCall(event);
    if (toolCall) {
      const startedAtMs = Date.now();
      const toolKey = toolCall.toolCallId ?? toolCall.name;
      pushToolStart(toolStarts, toolKey, {
        toolName: toolCall.name,
        toolCallId: toolCall.toolCallId,
        args: toolCall.args,
        startedAtMs,
      });
      auditToolStart({
        scope: options.auditScope,
        toolName: toolCall.name,
        toolCallId: toolCall.toolCallId,
        args: toolCall.args,
      });
      if (toolCall.name === "memory_write" && !options.memoryWriteEnabled) {
        return;
      }
      if (toolCall.name === "memory_write") {
        const parsed = parseMemoryWriteArgs(toolCall.args);
        if (!parsed) {
          return;
        }
        memoryWriteTasks.push(
          (async () => {
            if (parsed.scope === "daily") {
              await options.runtime.appendDailyMemory(parsed.content, {
                workspaceDir: options.workspaceDir,
                timezone: options.timezone,
                auditScope: options.auditScope,
              });
            } else {
              await options.runtime.updateLongTermMemory(parsed.content, {
                workspaceDir: options.workspaceDir,
                timezone: options.timezone,
                auditScope: options.auditScope,
              });
            }
          })()
        );
      }
      if (!options.isSilentTurn()) {
        options.onToolCall?.(toolCall.name, toolCall.args);
      }
    }

    const toolResult = tryGetToolResult(event);
    if (!toolResult) {
      return;
    }
    const endedAtMs = Date.now();
    const endedAt = new Date(endedAtMs).toISOString();
    const toolKey = toolResult.toolCallId ?? toolResult.name;
    let started = shiftToolStart(toolStarts, toolKey);
    if (!started && toolResult.toolCallId) {
      started = shiftToolStart(toolStarts, toolResult.name);
    }
    const durationMs =
      started !== undefined ? Math.max(0, endedAtMs - started.startedAtMs) : undefined;
    auditToolEnd({
      scope: options.auditScope,
      toolName: toolResult.name,
      toolCallId: toolResult.toolCallId,
      resultSummary: toolResult.result,
      status: toolResult.status,
      durationMs,
      error: toolResult.error,
    });
    toolDetails.push({
      toolName: toolResult.name,
      ...(toolResult.toolCallId ? { toolCallId: toolResult.toolCallId } : {}),
      status: toolResult.status,
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(started ? { startedAt: new Date(started.startedAtMs).toISOString() } : {}),
      endedAt,
      ...(started && started.args !== undefined ? { args: started.args } : {}),
      ...(toolResult.result !== undefined ? { resultSummary: toolResult.result } : {}),
      ...(toolResult.error ? { error: toolResult.error } : {}),
    });
    if (toolResult.name === "memory_write" && !options.memoryWriteEnabled) {
      return;
    }
    if (options.isSilentTurn()) {
      return;
    }
    toolCalls.push({ name: toolResult.name, result: toolResult.result });
  });

  return {
    unsubscribe,
    output,
    toolCalls,
    toolDetails,
    get lastAssistantMessageId() {
      return lastAssistantMessageId;
    },
    memoryWriteTasks,
    waitForSettledMemoryWrites: async () => {
      const pending = memoryWriteTasks.slice(settledMemoryTaskCount);
      settledMemoryTaskCount = memoryWriteTasks.length;
      if (pending.length > 0) {
        await Promise.all(pending);
      }
    },
  };
}
