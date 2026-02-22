import type { AgentRunFn } from "./chat-handler.js";
import type { StreamEvent } from "./types.js";
import type { AgentRunOptions, AgentRunResult } from "./agent-runner.js";

type AgentRunFnLike = (opts: AgentRunOptions) => Promise<AgentRunResult>;

type AdapterConfig = {
  workspaceDir: string;
  timezone: string;
  model?: string;
  onTerminalRecord?: AgentRunOptions["onTerminalRecord"];
};

function isCodexModel(model?: string): boolean {
  if (!model) return false;
  return /codex/i.test(model);
}

export function createAgentRunAdapter(cfg: AdapterConfig, runAgentFn: AgentRunFnLike): AgentRunFn {
  return async ({ prompt, sessionKey, runId, origin, isAborted, onDelta }) => {
    try {
      const result = await runAgentFn({
        runId,
        prompt,
        sessionKey,
        origin,
        isAborted,
        onTerminalRecord: cfg.onTerminalRecord,
        sessionId: isCodexModel(cfg.model) ? sessionKey : undefined,
        workspaceDir: cfg.workspaceDir,
        timezone: cfg.timezone,
        model: cfg.model,
        onTextDelta: (delta) => {
          onDelta({
            runId,
            sessionKey,
            seq: 0,
            state: "delta",
            message: {
              role: "assistant",
              content: [{ type: "text", text: delta }],
              timestamp: Date.now(),
            },
          } satisfies StreamEvent);
        },
      });

      onDelta({
        runId,
        sessionKey,
        seq: 0,
        state: "final",
        message: {
          role: "assistant",
          content: [{ type: "text", text: result.text }],
          timestamp: Date.now(),
        },
      } satisfies StreamEvent);

      return { status: "completed" };
    } catch (err) {
      return {
        status: "failed",
        reason: err instanceof Error ? err.message : "Unknown error",
      };
    }
  };
}
