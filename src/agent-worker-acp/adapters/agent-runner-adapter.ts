import {
  runAgent,
  type AgentRunResult,
  type AgentRunner,
  type LegacyToolCallEvent,
} from "../../assistant/agent-runner.js";
import type { SessionPromptParams, SessionPromptResult } from "../../contracts/acp/rpc-types.js";
import { normalizeStopReason } from "../stop-reason.js";
import {
  projectAgentMessageChunk,
  projectTerminalRecord,
  toSessionUpdateNotification,
  type ProjectedSessionUpdate,
} from "../session-update-projector.js";
import { mapToolExecutionEnd, mapToolExecutionStart } from "../tool-call-mapper.js";

import { SessionBridge } from "./session-bridge.js";

export interface AgentRunnerAdapterDeps {
  runAgent?: AgentRunner;
  emitNotification: (
    notification: ReturnType<typeof toSessionUpdateNotification>
  ) => void | Promise<void>;
  sessionBridge?: SessionBridge;
}

export interface SessionPromptExecutionResult extends SessionPromptResult {
  runId: string;
  text: string;
}

function isLegacyToolCallEvent(value: unknown): value is LegacyToolCallEvent {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return candidate.event === "tool_execution_start" || candidate.event === "tool_execution_end";
}

export class AgentRunnerAdapter {
  private readonly runAgentImpl: AgentRunner;
  private readonly emitNotification: AgentRunnerAdapterDeps["emitNotification"];
  private readonly sessionBridge: SessionBridge;
  private readonly activeRuns = new Map<string, AbortController>();

  constructor(deps: AgentRunnerAdapterDeps) {
    this.runAgentImpl = deps.runAgent ?? runAgent;
    this.emitNotification = deps.emitNotification;
    this.sessionBridge = deps.sessionBridge ?? new SessionBridge();
  }

  async prompt(params: SessionPromptParams): Promise<SessionPromptExecutionResult> {
    const session = this.sessionBridge.ensureSession(params.sessionId);
    const run = this.sessionBridge.startRun(params.sessionId);
    const controller = new AbortController();
    this.activeRuns.set(params.sessionId, controller);

    try {
      const runResult = await this.runAgentImpl({
        runId: run.runId,
        sessionId: params.sessionId,
        sessionKey: session.sessionKey,
        prompt: params.prompt,
        signal: controller.signal,
        callbacks: {
          onTextDelta: (delta) => {
            void this.emitUpdate(params.sessionId, projectAgentMessageChunk(delta));
          },
          onToolCall: (event, rawParams) => {
            void this.emitToolUpdate(params.sessionId, event, rawParams, run.runId);
          },
          onTerminalRecord: (record) => {
            void this.emitUpdate(params.sessionId, projectTerminalRecord(record));
          },
        },
      });

      return this.toPromptResult(run.runId, runResult);
    } catch (error) {
      if (controller.signal.aborted) {
        return {
          runId: run.runId,
          text: "",
          stopReason: "cancelled",
        };
      }

      throw error;
    } finally {
      this.activeRuns.delete(params.sessionId);
    }
  }

  cancelSession(sessionId: string): boolean {
    const controller = this.activeRuns.get(sessionId);
    if (controller === undefined) {
      return false;
    }

    controller.abort();
    return true;
  }

  private toPromptResult(runId: string, runResult: AgentRunResult): SessionPromptExecutionResult {
    return {
      runId,
      text: runResult.text,
      stopReason: normalizeStopReason(runResult.stopReason),
    };
  }

  private async emitToolUpdate(
    sessionId: string,
    event: LegacyToolCallEvent | string,
    rawParams: unknown,
    runId: string
  ): Promise<void> {
    if (typeof event === "string") {
      await this.emitUpdate(sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: `tool_${runId}_${Date.now()}`,
        title: event,
        kind: "execute",
        status: "pending",
        rawInput: rawParams,
      });
      return;
    }

    if (!isLegacyToolCallEvent(event)) {
      return;
    }

    if (event.event === "tool_execution_start") {
      await this.emitUpdate(sessionId, mapToolExecutionStart(event));
      return;
    }

    await this.emitUpdate(sessionId, mapToolExecutionEnd(event));
  }

  private async emitUpdate(sessionId: string, update: ProjectedSessionUpdate): Promise<void> {
    await this.emitNotification(toSessionUpdateNotification(sessionId, update));
  }
}
