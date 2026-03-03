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
  projectAgentThinkingChunk,
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

export interface PromptExecutionOptions {
  signal?: AbortSignal;
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

  async prompt(
    params: SessionPromptParams,
    options: PromptExecutionOptions = {}
  ): Promise<SessionPromptExecutionResult> {
    const session = this.sessionBridge.ensureSession(params.sessionId);
    const run = this.sessionBridge.startRun(params.sessionId);
    const controller = new AbortController();
    const externalSignal = options.signal;
    const onExternalAbort = () => {
      controller.abort();
    };
    if (externalSignal?.aborted === true) {
      controller.abort();
    } else {
      externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
    }
    const requestSessionKey = this.resolveSessionKey(params, session.sessionKey);
    const requestMemoryScope = this.resolveMemoryScope(params, requestSessionKey);
    const memoryWriteEnabled = this.resolveMemoryWriteEnabled(params);
    const origin = this.resolveOrigin(params);
    const isHeartbeat = this.resolveIsHeartbeat(params);
    this.activeRuns.set(params.sessionId, controller);

    try {
      const runResult = await this.runAgentImpl({
        runId: run.runId,
        sessionId: params.sessionId,
        sessionKey: requestSessionKey,
        memoryScope: requestMemoryScope,
        memoryWriteEnabled,
        origin,
        isHeartbeat,
        prompt: params.prompt,
        signal: controller.signal,
        callbacks: {
          onTextDelta: (delta) => {
            void this.emitUpdate(params.sessionId, projectAgentMessageChunk(delta));
          },
          onThinkingDelta: (delta) => {
            void this.emitUpdate(params.sessionId, projectAgentThinkingChunk(delta));
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
      externalSignal?.removeEventListener("abort", onExternalAbort);
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

  private resolveSessionKey(params: SessionPromptParams, fallback: string): string {
    const meta = params.meta;
    if (meta === undefined) {
      return fallback;
    }
    const candidate = meta.sessionKey;
    return typeof candidate === "string" && candidate.trim().length > 0
      ? candidate.trim()
      : fallback;
  }

  private resolveMemoryScope(params: SessionPromptParams, sessionKey: string): "main" | "spoke" {
    const meta = params.meta;
    if (meta !== undefined && (meta.memoryScope === "main" || meta.memoryScope === "spoke")) {
      return meta.memoryScope;
    }
    return sessionKey === "main" ? "main" : "spoke";
  }

  private resolveMemoryWriteEnabled(params: SessionPromptParams): boolean {
    const meta = params.meta;
    return meta !== undefined && meta.memoryWriteEnabled === true;
  }

  private resolveOrigin(params: SessionPromptParams): "user" | "system" {
    const meta = params.meta;
    if (meta !== undefined && meta.origin === "user") {
      return "user";
    }
    return "system";
  }

  private resolveIsHeartbeat(params: SessionPromptParams): boolean {
    const meta = params.meta;
    return meta !== undefined && meta.isHeartbeat === true;
  }
}
