import type { CompactionEventTracker } from "./compaction-runtime.js";

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
    }
  ) => Promise<void>;
  updateLongTermMemory: (
    content: string,
    options: {
      workspaceDir: string;
      timezone: string;
    }
  ) => Promise<void>;
};

export type AgentEventSubscriberOptions = {
  session: AgentEventSubscriptionSession;
  runtime: AgentEventSubscriberRuntime;
  memoryWriteEnabled: boolean;
  workspaceDir: string;
  timezone: string;
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

function tryGetToolCall(event: unknown): { name: string; args: unknown } | null {
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
  };
}

function tryGetToolResult(event: unknown): { name: string; result: unknown } | null {
  const top = asRecord(event);
  if (!top || top.type !== "tool_execution_end") {
    return null;
  }
  const toolName = top.toolName;
  if (typeof toolName !== "string") {
    return null;
  }
  return {
    name: toolName,
    result: top.result,
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
              });
            } else {
              await options.runtime.updateLongTermMemory(parsed.content, {
                workspaceDir: options.workspaceDir,
                timezone: options.timezone,
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
    if (toolResult.name === "memory_write" && !options.memoryWriteEnabled) {
      return;
    }
    if (options.isSilentTurn()) {
      return;
    }
    toolCalls.push(toolResult);
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
