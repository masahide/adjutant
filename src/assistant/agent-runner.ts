export type LegacyToolCallEvent =
  | {
      event: "tool_execution_start";
      toolCallId?: string;
      name: string;
      title?: string;
      kind?: "read" | "edit" | "execute" | "search";
      rawInput?: unknown;
      startedAt?: string;
    }
  | {
      event: "tool_execution_end";
      toolCallId?: string;
      name: string;
      status?: "ok" | "error";
      rawOutput?: unknown;
      error?: string;
      endedAt?: string;
    };

export interface TerminalRecordEvent {
  runId: string;
  sessionKey: string;
  actionType: string;
  status?: "pending-timeline" | "recorded";
  timelineOffset?: number;
  ts?: string;
}

export interface AgentRunCallbacks {
  onTextDelta?: (delta: string) => void;
  onToolCall?: (event: LegacyToolCallEvent | string, params?: unknown) => void;
  onTerminalRecord?: (record: TerminalRecordEvent) => void;
}

export interface AgentRunOptions {
  runId: string;
  prompt: string;
  sessionKey: string;
  sessionId?: string;
  signal?: AbortSignal;
  callbacks?: AgentRunCallbacks;
}

export interface AgentRunResult {
  runId: string;
  text: string;
  stopReason?: string;
}

export type AgentRunner = (options: AgentRunOptions) => Promise<AgentRunResult>;

export async function runAgent(options: AgentRunOptions): Promise<AgentRunResult> {
  if (options.signal?.aborted === true) {
    throw new Error("aborted");
  }

  options.callbacks?.onTextDelta?.(options.prompt);

  return {
    runId: options.runId,
    text: options.prompt,
    stopReason: "end_turn",
  };
}
