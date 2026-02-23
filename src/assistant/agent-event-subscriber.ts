import type { CompactionEventTracker } from "./compaction-runtime.js";
import { auditToolEnd, auditToolStart, type AgentAuditScope } from "./agent-audit.js";

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

export type AgentEventSubscription = {
  unsubscribe: () => void;
  output: { text: string };
  toolCalls: Array<{ name: string; result: unknown }>;
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

export function createAgentEventSubscriber(
  options: AgentEventSubscriberOptions
): AgentEventSubscription {
  const output = { text: "" };
  const toolCalls: Array<{ name: string; result: unknown }> = [];
  const memoryWriteTasks: Promise<void>[] = [];
  const toolStartAtMs = new Map<string, number[]>();
  let settledMemoryTaskCount = 0;

  const unsubscribe = options.session.subscribe((event) => {
    options.compactionTracker.onEvent(event);

    const delta = tryGetTextDelta(event);
    if (delta && !options.isSilentTurn()) {
      output.text += delta;
      options.onTextDelta?.(delta);
    }

    const toolCall = tryGetToolCall(event);
    if (toolCall) {
      const startedAt = Date.now();
      const toolKey = toolCall.toolCallId ?? toolCall.name;
      const starts = toolStartAtMs.get(toolKey) ?? [];
      starts.push(startedAt);
      toolStartAtMs.set(toolKey, starts);
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
    const endedAt = Date.now();
    const toolKey = toolResult.toolCallId ?? toolResult.name;
    const starts = toolStartAtMs.get(toolKey);
    const startedAt = starts?.shift();
    if (starts && starts.length === 0) {
      toolStartAtMs.delete(toolKey);
    }
    auditToolEnd({
      scope: options.auditScope,
      toolName: toolResult.name,
      toolCallId: toolResult.toolCallId,
      resultSummary: toolResult.result,
      status: toolResult.status,
      durationMs: startedAt !== undefined ? Math.max(0, endedAt - startedAt) : undefined,
      error: toolResult.error,
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
