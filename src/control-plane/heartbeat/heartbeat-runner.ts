import { readFile } from "node:fs/promises";

import type { GlobalConcurrencyQueue } from "../proactive/global-concurrency-queue.js";
import type { HeartbeatHistoryPage, HeartbeatResultStore } from "./result-store.js";
import {
  HEARTBEAT_RESULT_SCHEMA_V1,
  HEARTBEAT_TOOL_NAME,
  type HeartbeatRunResultV1,
  type ReportHeartbeatStatusPayload,
  validateReportHeartbeatStatusPayload,
} from "./schema.js";

export type HeartbeatObservedToolCall = {
  toolCallId?: string;
  toolName?: string;
  status?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
};

export type HeartbeatPromptExecutionResult = {
  runId?: string;
  text?: string;
  toolCalls: HeartbeatObservedToolCall[];
};

type HeartbeatRunnerOptions = {
  intervalMs?: number;
  timeoutMs?: number;
  nowIso?: () => string;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  readPrompt?: () => Promise<string>;
  executePrompt: (input: {
    reason: string;
    prompt: string;
    timeoutMs: number;
  }) => Promise<HeartbeatPromptExecutionResult>;
  beforeRun?: () => Promise<{ skipReason: string } | null>;
  globalQueue?: GlobalConcurrencyQueue;
  resultStore: HeartbeatResultStore;
  emitEvent?: (result: HeartbeatRunResultV1) => void;
  onWarn?: (message: string, meta?: Record<string, unknown>) => void;
};

export type HeartbeatRunner = {
  start: () => void;
  stop: () => void;
  runOnce: (reason: string) => Promise<HeartbeatRunResultV1>;
  getLast: () => HeartbeatRunResultV1 | null;
  getHistory: (input?: { limit?: number; cursor?: string }) => HeartbeatHistoryPage;
};

const HEARTBEAT_CONTRACT = [
  "You must call `report_heartbeat_status` exactly once.",
  "status must be one of: no_action_needed, needs_attention, task_completed.",
  "notify should be true only when user notification is required.",
  "reason should be concise and actionable.",
].join("\n");

function normalizeToolName(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().toLowerCase();
}

function isHeartbeatToolCall(value: HeartbeatObservedToolCall): boolean {
  const toolName = normalizeToolName(value.toolName);
  return toolName === HEARTBEAT_TOOL_NAME || toolName.includes("report_heartbeat_status");
}

function ensurePromptContract(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return "";
  }
  if (trimmed.toLowerCase().includes("report_heartbeat_status")) {
    return trimmed;
  }
  return `${trimmed}\n\n${HEARTBEAT_CONTRACT}`;
}

function parseHeartbeatReport(input: HeartbeatPromptExecutionResult): {
  payload?: ReportHeartbeatStatusPayload;
  reason?: string;
} {
  const heartbeatCalls = input.toolCalls.filter((toolCall) => isHeartbeatToolCall(toolCall));
  if (heartbeatCalls.length === 0) {
    return {
      reason: "missing-report-heartbeat-status-tool-call",
    };
  }
  if (heartbeatCalls.length > 1) {
    return {
      reason: "multiple-report-heartbeat-status-tool-call",
    };
  }
  const payload = heartbeatCalls[0]?.rawInput;
  if (!validateReportHeartbeatStatusPayload(payload)) {
    return {
      reason: "invalid-report-heartbeat-status-payload",
    };
  }
  return {
    payload,
  };
}

function buildResult(input: {
  nowIso: string;
  status: "ran" | "skipped" | "failed";
  eventStatus: "sent" | "ok-token" | "ok-empty" | "skipped" | "failed";
  reason?: string;
  runId?: string;
}): HeartbeatRunResultV1 {
  return {
    schema: HEARTBEAT_RESULT_SCHEMA_V1,
    status: input.status,
    event: {
      status: input.eventStatus,
      reason: input.reason,
    },
    ts: input.nowIso,
    runId: input.runId,
  };
}

export function createHeartbeatRunner(options: HeartbeatRunnerOptions): HeartbeatRunner {
  const nowIso = options.nowIso ?? (() => new Date().toISOString());
  const intervalMs = Math.max(0, Math.floor(options.intervalMs ?? 30 * 60 * 1000));
  const timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? 30_000));
  const readPrompt = options.readPrompt ?? (async () => await readFile("HEARTBEAT.md", "utf8"));
  const setIntervalFn = options.setIntervalFn ?? setInterval;
  const clearIntervalFn = options.clearIntervalFn ?? clearInterval;
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight = false;

  const finalize = async (result: HeartbeatRunResultV1): Promise<HeartbeatRunResultV1> => {
    await options.resultStore.append(result);
    options.emitEvent?.(result);
    return result;
  };

  const runOnce = async (reason: string): Promise<HeartbeatRunResultV1> => {
    if (inFlight) {
      return await finalize(
        buildResult({
          nowIso: nowIso(),
          status: "skipped",
          eventStatus: "skipped",
          reason: "heartbeat-already-running",
        })
      );
    }

    inFlight = true;
    let release: (() => void) | undefined;
    try {
      const precheck = await options.beforeRun?.();
      if (precheck !== null && precheck !== undefined) {
        return await finalize(
          buildResult({
            nowIso: nowIso(),
            status: "skipped",
            eventStatus: "skipped",
            reason: precheck.skipReason,
          })
        );
      }

      if (options.globalQueue !== undefined) {
        const lease = await options.globalQueue.acquire("heartbeat");
        release = lease.release;
      }

      let prompt = "";
      try {
        prompt = await readPrompt();
      } catch (error) {
        options.onWarn?.("heartbeat.prompt.read_failed", {
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      const promptWithContract = ensurePromptContract(prompt);
      if (promptWithContract.length === 0) {
        return await finalize(
          buildResult({
            nowIso: nowIso(),
            status: "skipped",
            eventStatus: "skipped",
            reason: "empty-heartbeat-file",
          })
        );
      }

      const executed = await options.executePrompt({
        reason,
        prompt: promptWithContract,
        timeoutMs,
      });
      const parsed = parseHeartbeatReport(executed);
      if (parsed.payload === undefined) {
        return await finalize(
          buildResult({
            nowIso: nowIso(),
            status: "failed",
            eventStatus: "failed",
            reason: parsed.reason,
            runId: executed.runId,
          })
        );
      }

      const eventStatus =
        parsed.payload.notify === true
          ? "sent"
          : parsed.payload.reason !== undefined && parsed.payload.reason.trim().length > 0
            ? "ok-token"
            : "ok-empty";
      return await finalize(
        buildResult({
          nowIso: nowIso(),
          status: "ran",
          eventStatus,
          reason: parsed.payload.reason,
          runId: executed.runId,
        })
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("SESSION_BUSY")) {
        return await finalize(
          buildResult({
            nowIso: nowIso(),
            status: "skipped",
            eventStatus: "skipped",
            reason: "session-busy",
          })
        );
      }
      return await finalize(
        buildResult({
          nowIso: nowIso(),
          status: "failed",
          eventStatus: "failed",
          reason: message,
        })
      );
    } finally {
      release?.();
      inFlight = false;
    }
  };

  const start = (): void => {
    if (timer !== undefined || intervalMs <= 0) {
      return;
    }
    timer = setIntervalFn(() => {
      void runOnce("periodic");
    }, intervalMs);
  };

  const stop = (): void => {
    if (timer === undefined) {
      return;
    }
    clearIntervalFn(timer);
    timer = undefined;
  };

  return {
    start,
    stop,
    runOnce,
    getLast: () => options.resultStore.getLast(),
    getHistory: (input) => options.resultStore.list(input),
  };
}
