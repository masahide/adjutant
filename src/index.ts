import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer, type ViteDevServer } from "vite";

import { createMarkdownSummaryBatchService } from "./assistant/markdown-summary-batch.js";
import { loadCollectorSlackConfig } from "./collector-slack/config.js";
import { loadDeliverSlackConfig } from "./deliver-slack/config.js";
import type {
  CollectorIngestRequest,
  DeliverCompletedNotification,
} from "./contracts/process-rpc/method-types.js";
import type { ClientNotification } from "./contracts/acp/rpc-types.js";
import { PermissionGateway } from "./control-plane/acp/permission-gateway.js";
import { resolveOrCreateSession } from "./control-plane/acp/session-recovery-resolver.js";
import { SessionRecoveryStore } from "./control-plane/acp/session-recovery-store.js";
import { WorkerSupervisor } from "./control-plane/acp/worker-supervisor.js";
import { AgentAuditLog } from "./control-plane/audit/agent-audit-log.js";
import { readRunAudit } from "./control-plane/audit/audit-reader.js";
import { DeliverCompletionStore } from "./control-plane/deliver-completion-store.js";
import {
  toPermissionSummary,
  type AcceptedResponse,
  type GetHeartbeatHistoryResponse,
  type StreamEventType,
  type ThreadSnapshotResponse,
} from "./control-plane/contracts/http-api.js";
import { toErrorSummary } from "./control-plane/http/error-summary.js";
import {
  mapPermissionEventToChatStreamEvent,
  mapPromptResultToChatStreamEvent,
  mapRunFailureToChatStreamEvent,
  mapSessionUpdateToChatStreamEvent,
} from "./control-plane/http/chat-stream-event-mapper.js";
import { ChatHistoryStore } from "./control-plane/http/chat-history-store.js";
import { createControlPlaneRequestHandler } from "./control-plane/http/control-plane-router.js";
import { createActivityFeedReader } from "./control-plane/http/activity-feed.js";
import { RunLifecycle } from "./control-plane/http/run-lifecycle.js";
import { RunEventBuffer } from "./control-plane/http/run-event-buffer.js";
import { SessionThreadCoordinator } from "./control-plane/http/session-thread-coordinator.js";
import { SseHub } from "./control-plane/http/sse-hub.js";
import { ThreadRepository } from "./control-plane/http/thread-repository.js";
import { writeStructuredLog } from "./control-plane/logging/structured-log.js";
import { CollectorSupervisor } from "./control-plane/process-rpc/collector-supervisor.js";
import { DeliverEnqueueHandler } from "./control-plane/process-rpc/deliver-handler.js";
import { DeliverQueueCoordinator } from "./control-plane/process-rpc/deliver-queue-coordinator.js";
import { DeliverQueueStore } from "./control-plane/process-rpc/deliver-queue-store.js";
import { DeliverSupervisor } from "./control-plane/process-rpc/deliver-supervisor.js";
import { CollectorIngestHandler } from "./control-plane/process-rpc/ingest-handler.js";
import { IngestInboxStore } from "./control-plane/process-rpc/ingest-inbox-store.js";
import type { IngestProjection } from "./control-plane/process-rpc/ingest-projection.js";
import { replayPendingRecords } from "./control-plane/process-rpc/replay-runner.js";
import { ProcessRpcServer } from "./control-plane/process-rpc/server.js";
import { IdempotencyStore } from "./control-plane/idempotency-store.js";
import type { Cursor } from "./runtime/journal-store.js";
import { initializeSandboxRuntime } from "./sandbox/runtime.js";
import { applySandboxToWorkerEnv } from "./sandbox/worker-env-bridge.js";
import { buildCollectorDispatchPayload } from "./control-plane/proactive/dispatch-payload.js";
import { createGlobalConcurrencyQueue } from "./control-plane/proactive/global-concurrency-queue.js";
import { createProactiveIngressService } from "./control-plane/proactive/ingress-service.js";
import { createPendingFlusher } from "./control-plane/proactive/pending-flusher.js";
import { TimelineStore } from "./control-plane/proactive/timeline-store.js";
import { WatermarkStore } from "./control-plane/proactive/watermark-store.js";
import { createHeartbeatRunner } from "./control-plane/heartbeat/heartbeat-runner.js";
import { HeartbeatResultStore } from "./control-plane/heartbeat/result-store.js";
import { buildSnapshotResponse } from "./control-plane/http/snapshot-builder.js";
import { loadProjectEnv } from "./runtime/load-project-env.js";
import { ensureWorkspaceReady, resolveRuntimeDirectories } from "./runtime/runtime-directories.js";
import { renderMinimalUiPage } from "./ui/minimal-page.js";
import { UiRuntime } from "./ui/runtime.js";
import { parseNotificationDecision } from "./control-plane/notification-decision.js";

loadProjectEnv();

function createWorkerSupervisor(
  cwd: string,
  stateDir: string,
  workspaceDir: string,
  sandbox: {
    mode: "off" | "non-main" | "all";
    enabled: boolean;
    runSpec?: {
      image: string;
      hostWorkspaceDir: string;
      containerWorkdir: string;
      containerHome: string;
      user: string;
      envAllowlist?: string[];
      readOnlyRoot?: boolean;
      tmpfs?: string[];
      network?: string;
      capDrop?: string[];
      pidsLimit?: number;
      memory?: string;
    };
  },
  onLog: (entry: Record<string, unknown>) => void,
  onNotification: (notification: { method: string; params: Record<string, unknown> }) => void
): WorkerSupervisor {
  const workerEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ADJUTANT_STATE_DIR: stateDir,
    ADJUTANT_WORKSPACE_DIR: workspaceDir,
    ACP_WORKER_SESSION_STORE_PATH: join(stateDir, "worker", "session-store.json"),
  };

  if (sandbox.enabled && sandbox.runSpec !== undefined) {
    applySandboxToWorkerEnv(workerEnv, {
      enabled: true,
      mode: sandbox.mode,
      runSpec: sandbox.runSpec,
    });
  } else {
    applySandboxToWorkerEnv(workerEnv, {
      enabled: false,
      mode: sandbox.mode,
    });
  }

  return new WorkerSupervisor({
    command: process.execPath,
    args: ["--import", "tsx", "src/agent-worker-acp/stdio-server.ts"],
    cwd,
    env: workerEnv,
    maxRestarts: 3,
    restartDelayMs: 100,
    onLog,
    onNotification,
  });
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true") {
    return true;
  }
  if (normalized === "0" || normalized === "false") {
    return false;
  }
  return fallback;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(1, Math.floor(parsed));
}

type PhaseBRolloutScope = "main" | "all";

function resolvePhaseBRolloutScope(value: string | undefined): PhaseBRolloutScope {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "all") {
    return "all";
  }
  return "main";
}

function isPhaseBEnabledForSession(scope: PhaseBRolloutScope, sessionKey: string): boolean {
  if (scope === "all") {
    return true;
  }
  return sessionKey === "main";
}

function toCommandRequestHash(message: string): string {
  return JSON.stringify({ message });
}

type SubmitPromptInput = {
  sessionKey: string;
  message: string;
  idempotencyKey?: string;
  origin?: "user" | "system";
  isHeartbeat?: boolean;
  memoryScope?: "main" | "spoke";
  recordHistory?: boolean;
};

type SubmitPromptResult = {
  accepted: AcceptedResponse;
  sessionId: string;
  idempotency: "miss" | "duplicate";
};

export async function main(): Promise<void> {
  const runtimeDirectories = resolveRuntimeDirectories({
    env: process.env,
    projectRoot: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  });
  const projectRoot = runtimeDirectories.projectRoot;
  const stateDir = runtimeDirectories.stateDir;
  const workspaceDir = runtimeDirectories.workspaceDir;
  await ensureWorkspaceReady(workspaceDir);
  const logControlPlane = (input: {
    level?: "debug" | "info" | "warn" | "error";
    event: string;
    message?: string;
    runId?: string | null;
    sessionKey?: string | null;
    toolCallId?: string | null;
    [key: string]: unknown;
  }) => {
    writeStructuredLog("control-plane", input);
  };

  const phaseBRolloutScope = resolvePhaseBRolloutScope(process.env.ADJUTANT_PHASE_B_ROLLOUT_SCOPE);
  const summaryBatchEnabled = parseBoolean(
    process.env.ADJUTANT_MARKDOWN_SUMMARY_BATCH_ENABLED,
    true
  );
  const sandboxRuntime = await initializeSandboxRuntime({
    projectRoot,
    workspaceDir,
  });
  const collectorConfig = loadCollectorSlackConfig({
    env: process.env,
    cwd: projectRoot,
    stateDir,
  });
  const deliverConfig = loadDeliverSlackConfig({ env: process.env });
  const recoveryStore = SessionRecoveryStore.fromStateDir(stateDir, {
    onWarn: (message, meta) => {
      logControlPlane({
        level: "warn",
        event: "session_recovery.warn",
        message,
        runId: null,
        sessionKey: typeof meta?.sessionKey === "string" ? meta.sessionKey : null,
        toolCallId: null,
        details: meta,
      });
    },
  });
  await recoveryStore.initialize();
  const threadRepository = ThreadRepository.fromStateDir(stateDir, {
    onWarn: (message, meta) => {
      logControlPlane({
        level: "warn",
        event: "thread_repository.warn",
        message,
        runId: null,
        sessionKey: typeof meta?.threadId === "string" ? meta.threadId : null,
        toolCallId: null,
        details: meta,
      });
    },
  });
  await threadRepository.initialize();
  const agentAuditLog = AgentAuditLog.fromStateDir(stateDir, process.env, {
    onWarn: (message, meta) => {
      logControlPlane({
        level: "warn",
        event: "agent_audit.warn",
        message,
        runId: typeof meta?.runId === "string" ? meta.runId : null,
        sessionKey: typeof meta?.sessionKey === "string" ? meta.sessionKey : null,
        toolCallId: typeof meta?.toolCallId === "string" ? meta.toolCallId : null,
        details: meta,
      });
    },
  });
  const summaryBatchService = summaryBatchEnabled
    ? createMarkdownSummaryBatchService({
        workspaceDir,
        timezone: process.env.ADJUTANT_MARKDOWN_SUMMARY_BATCH_TIMEZONE ?? "UTC",
        sessionTranscriptsDir:
          process.env.ADJUTANT_SESSION_TRANSCRIPTS_DIR?.trim() ||
          join(stateDir, "agents", "main", "transcripts"),
        watermarkPath:
          process.env.ADJUTANT_SUMMARY_BATCH_WATERMARK_PATH?.trim() ||
          join(stateDir, "agents", "main", "summary-batch-watermark.json"),
        onWarn: (message, meta) => {
          logControlPlane({
            level: "warn",
            event: "summary_batch.warn",
            message,
            runId: null,
            sessionKey: null,
            toolCallId: null,
            details: meta,
          });
        },
      })
    : undefined;

  let viteDevServer: ViteDevServer | undefined;
  const uiMiddlewareEnabled = parseBoolean(process.env.ADJUTANT_UI_VITE_MIDDLEWARE, true);
  if (uiMiddlewareEnabled) {
    try {
      viteDevServer = await createViteServer({
        configFile: resolve(projectRoot, "vite.config.ts"),
        server: {
          middlewareMode: true,
          hmr: false,
        },
      });
    } catch (error) {
      const summary = toErrorSummary(error);
      logControlPlane({
        level: "warn",
        event: "ui.vite_middleware.disabled",
        message: summary.errorMessage,
        runId: null,
        sessionKey: null,
        toolCallId: null,
      });
      viteDevServer = undefined;
    }
  }

  const runLifecycle = new RunLifecycle();
  const sseHub = new SseHub();
  const runEventBuffer = new RunEventBuffer({ retentionMs: 60_000 });
  const chatHistoryStore = ChatHistoryStore.fromStateDir(stateDir);
  await chatHistoryStore.initialize();
  const idempotencyStore = IdempotencyStore.fromStateDir(stateDir, {
    onWarn: (message, meta) => {
      logControlPlane({
        level: "warn",
        event: "idempotency.warn",
        message,
        runId: null,
        sessionKey: null,
        toolCallId: null,
        details: meta,
      });
    },
  });
  await idempotencyStore.initialize();
  const ingestInboxStore = IngestInboxStore.fromStateDir(stateDir);
  await ingestInboxStore.initialize();
  const deliverQueueStore = DeliverQueueStore.fromStateDir(stateDir);
  await deliverQueueStore.initialize();
  const deliverCompletionStore = DeliverCompletionStore.fromStateDir(stateDir);
  await deliverCompletionStore.initialize();
  const timelineStore = TimelineStore.fromStateDir(stateDir);
  const watermarkStore = WatermarkStore.fromStateDir(stateDir, {
    onWarn: (message, meta) => {
      logControlPlane({
        level: "warn",
        event: "watermark.warn",
        message,
        runId: null,
        sessionKey: typeof meta?.sessionKey === "string" ? meta.sessionKey : null,
        toolCallId: null,
        details: meta,
      });
    },
  });
  await watermarkStore.initialize();
  const heartbeatResultStore = HeartbeatResultStore.fromStateDir(stateDir, {
    onWarn: (message, meta) => {
      logControlPlane({
        level: "warn",
        event: "heartbeat.result.warn",
        message,
        runId: null,
        sessionKey: null,
        toolCallId: null,
        details: meta,
      });
    },
  });
  await heartbeatResultStore.initialize();
  const globalQueue = createGlobalConcurrencyQueue({
    maxConcurrent: parsePositiveInt(process.env.ADJUTANT_GLOBAL_MAX_CONCURRENT, 3),
    dmBurstSlot: parsePositiveInt(process.env.ADJUTANT_GLOBAL_DM_BURST_SLOT, 1),
    maxRunningDm: parsePositiveInt(process.env.ADJUTANT_GLOBAL_MAX_RUNNING_DM, 3),
    starvationMs: parsePositiveInt(process.env.ADJUTANT_GLOBAL_STARVATION_MS, 120_000),
  });
  let deliverSupervisor: DeliverSupervisor | undefined;
  const deliverQueueCoordinator = new DeliverQueueCoordinator({
    queueStore: deliverQueueStore,
    completionStore: deliverCompletionStore,
    resolveDispatcher: () => deliverSupervisor,
    dispatchTimeoutMs: 5_000,
  });
  const sessionThreadCoordinator = new SessionThreadCoordinator({
    threadRepository,
    recoveryStore,
    toErrorSummary,
    onRecoveryPersistFailed: (input) => {
      logControlPlane({
        level: "warn",
        event: "session_recovery.persist_failed",
        runId: input.runId,
        sessionKey: input.sessionKey,
        toolCallId: null,
        errorCode: input.errorCode,
        message: input.message,
      });
    },
  });
  const permissionRequestRunById = new Map<string, { runId: string; sessionKey: string }>();
  const clearPermissionRequestRun = (runId: string) => {
    for (const [requestId, tracked] of permissionRequestRunById) {
      if (tracked.runId === runId) {
        permissionRequestRunById.delete(requestId);
      }
    }
  };

  // Run-level accumulators for thinking text and tool calls (used to build structured history content).
  const runThinkingAccum = new Map<string, string>();
  type ToolCallAccumEntry = {
    toolCallId: string;
    toolName: string;
    status: string;
    argsText?: string;
    rawInput?: unknown;
    result?: string;
  };
  const runToolCallAccum = new Map<string, Map<string, ToolCallAccumEntry>>();
  const clearRunAccumulators = (runId: string) => {
    runThinkingAccum.delete(runId);
    runToolCallAccum.delete(runId);
  };
  type SessionUpdateListener = (update: Record<string, unknown>) => void;
  const sessionUpdateListenerBySessionId = new Map<string, Set<SessionUpdateListener>>();
  const subscribeSessionUpdates = (
    sessionId: string,
    listener: SessionUpdateListener
  ): (() => void) => {
    const listeners = sessionUpdateListenerBySessionId.get(sessionId);
    if (listeners !== undefined) {
      listeners.add(listener);
    } else {
      sessionUpdateListenerBySessionId.set(sessionId, new Set([listener]));
    }
    return () => {
      const current = sessionUpdateListenerBySessionId.get(sessionId);
      if (current === undefined) {
        return;
      }
      current.delete(listener);
      if (current.size === 0) {
        sessionUpdateListenerBySessionId.delete(sessionId);
      }
    };
  };
  const safeStringify = (value: unknown): string => {
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  };

  const emitSse = (event: StreamEventType, data: Record<string, unknown>) => {
    sseHub.broadcast(event, data);
  };
  const uiRuntime = new UiRuntime({
    resolveRunId: (sessionId) => runLifecycle.resolveRunId(sessionId),
  });
  const permissionGateway = new PermissionGateway({
    emitUiEvent: (event) => {
      uiRuntime.onPermissionEvent(event);
      emitSse(event.type, event.payload);

      const requestId =
        typeof event.payload.requestId === "string" ? event.payload.requestId : undefined;
      if (requestId === undefined) {
        return;
      }
      if (event.type === "permission/requested") {
        const runId = typeof event.payload.runId === "string" ? event.payload.runId : undefined;
        if (runId === undefined) {
          return;
        }
        const run = runLifecycle.runs().get(runId);
        if (run === undefined) {
          return;
        }
        permissionRequestRunById.set(requestId, { runId, sessionKey: run.sessionKey });
        const mapped = mapPermissionEventToChatStreamEvent({
          runId,
          sessionKey: run.sessionKey,
          event,
        });
        if (mapped !== undefined) {
          runEventBuffer.append(runId, mapped);
        }
        return;
      }

      const tracked = permissionRequestRunById.get(requestId);
      if (tracked === undefined) {
        return;
      }
      permissionRequestRunById.delete(requestId);
      const mapped = mapPermissionEventToChatStreamEvent({
        runId: tracked.runId,
        sessionKey: tracked.sessionKey,
        event,
      });
      if (mapped !== undefined) {
        runEventBuffer.append(tracked.runId, mapped);
      }
    },
  });

  const supervisor = createWorkerSupervisor(
    projectRoot,
    stateDir,
    workspaceDir,
    sandboxRuntime,
    (entry) => {
      logControlPlane({
        level: entry.level === "error" ? "error" : entry.level === "warn" ? "warn" : "info",
        event: "worker_supervisor.log",
        message: typeof entry.message === "string" ? entry.message : undefined,
        runId: null,
        sessionKey: null,
        toolCallId: null,
        details: entry,
      });
    },
    (notification) => {
      if (notification.method !== "session/update") {
        return;
      }
      const sessionId = notification.params.sessionId;
      const update = notification.params.update;
      if (typeof sessionId !== "string" || typeof update !== "object" || update === null) {
        return;
      }
      const updateRecord = update as Record<string, unknown>;

      const clientNotification: ClientNotification = {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: updateRecord,
        },
      };
      uiRuntime.onAcpSessionUpdate(clientNotification);
      const listeners = sessionUpdateListenerBySessionId.get(sessionId);
      if (listeners !== undefined) {
        for (const listener of listeners) {
          listener(updateRecord);
        }
      }

      const runId = runLifecycle.resolveRunId(sessionId);
      if (runId === undefined) {
        return;
      }

      const run = runLifecycle.runs().get(runId);
      if (
        run === undefined ||
        typeof run.sessionKey !== "string" ||
        (run.status !== "accepted" && run.status !== "running")
      ) {
        return;
      }

      const sessionUpdate = updateRecord.sessionUpdate;

      // Accumulate thinking chunks for structured history content.
      if (sessionUpdate === "agent_thinking_chunk") {
        const content = updateRecord.content;
        const text =
          typeof content === "object" && content !== null
            ? (content as Record<string, unknown>).text
            : undefined;
        if (typeof text === "string") {
          const prev = runThinkingAccum.get(runId) ?? "";
          runThinkingAccum.set(runId, prev + text);
        }
      }

      if (sessionUpdate === "tool_call") {
        const title = updateRecord.title;
        const kind = updateRecord.kind;
        const toolCallId = updateRecord.toolCallId;
        const rawInput = updateRecord.rawInput;
        const toolName =
          typeof title === "string" && title.trim().length > 0
            ? title.trim()
            : typeof kind === "string" && kind.trim().length > 0
              ? kind.trim()
              : "tool";
        // Accumulate tool call for structured history content.
        if (typeof toolCallId === "string") {
          let tcMap = runToolCallAccum.get(runId);
          if (!tcMap) {
            tcMap = new Map();
            runToolCallAccum.set(runId, tcMap);
          }
          tcMap.set(toolCallId, {
            toolCallId,
            toolName,
            status: "started",
            argsText: rawInput !== undefined ? safeStringify(rawInput) : undefined,
            rawInput,
          });
        }
        agentAuditLog.appendToolStart({
          runId,
          sessionKey: run.sessionKey,
          toolName,
          toolCallId: typeof toolCallId === "string" ? toolCallId : undefined,
          args: rawInput,
        });
        logControlPlane({
          event: "tool_call.started",
          runId,
          sessionKey: run.sessionKey,
          toolCallId: typeof toolCallId === "string" ? toolCallId : null,
          toolName,
        });
      } else if (sessionUpdate === "tool_call_update") {
        const toolCallId = updateRecord.toolCallId;
        const status = updateRecord.status;
        const updateTitle = updateRecord.title;
        const updateKind = updateRecord.kind;
        const rawOutput = updateRecord.rawOutput;
        const updateToolName =
          typeof updateTitle === "string" && updateTitle.trim().length > 0
            ? updateTitle.trim()
            : typeof updateKind === "string" && updateKind.trim().length > 0
              ? updateKind.trim()
              : undefined;

        // Update tool call accumulator: upsert to handle updates for previously unseen toolCallIds.
        if (typeof toolCallId === "string") {
          let tcMap = runToolCallAccum.get(runId);
          if (!tcMap) {
            tcMap = new Map();
            runToolCallAccum.set(runId, tcMap);
          }
          const existing = tcMap.get(toolCallId);
          if (existing) {
            if (status === "completed" || status === "failed") {
              existing.status = status as string;
            }
            if (updateToolName && existing.toolName === "tool") {
              existing.toolName = updateToolName;
            }
            if (rawOutput !== undefined) {
              existing.result = safeStringify(rawOutput);
            }
          } else {
            tcMap.set(toolCallId, {
              toolCallId,
              toolName: updateToolName ?? "tool",
              status: typeof status === "string" ? (status as string) : "started",
              rawInput: undefined,
              result: rawOutput !== undefined ? safeStringify(rawOutput) : undefined,
            });
          }
        }
        if (status === "completed" || status === "failed") {
          const toolName = updateToolName ?? "tool";
          agentAuditLog.appendToolEnd({
            runId,
            sessionKey: run.sessionKey,
            toolName,
            toolCallId: typeof toolCallId === "string" ? toolCallId : undefined,
            status: status === "completed" ? "ok" : "error",
            resultSummary: rawOutput,
            error:
              status === "failed" && typeof updateRecord.error === "string"
                ? updateRecord.error
                : undefined,
          });
          logControlPlane({
            event: "tool_call.completed",
            level: status === "failed" ? "warn" : "info",
            runId,
            sessionKey: run.sessionKey,
            toolCallId: typeof toolCallId === "string" ? toolCallId : null,
            status,
          });
        }
      }

      emitSse("run/update", { runId, sessionId, update: updateRecord });

      const mapped = mapSessionUpdateToChatStreamEvent({
        runId,
        sessionKey: run.sessionKey,
        update: updateRecord,
      });
      if (mapped !== undefined) {
        runEventBuffer.append(runId, mapped);
      }
    }
  );
  let submitPromptForCollector:
    | ((input: SubmitPromptInput) => Promise<SubmitPromptResult>)
    | undefined;
  const ingestCursorByRunId = new Map<string, Cursor>();
  const notificationRunContextByRunId = new Map<
    string,
    {
      sessionKey: string;
      notificationUid: string;
      title?: string;
      originalMessageText: string;
      permalink?: string;
      teamId?: string;
      channelId?: string;
    }
  >();
  type CollectorIngestPending = {
    request: CollectorIngestRequest;
    projection: IngestProjection;
    cursor: Cursor;
    replayed: boolean;
  };

  const commitIngestCursorForRun = async (
    runId: string,
    terminalStatus: "completed" | "failed" | "cancelled"
  ): Promise<void> => {
    const cursor = ingestCursorByRunId.get(runId);
    if (cursor === undefined) {
      return;
    }
    try {
      await ingestInboxStore.commitThrough(cursor);
      logControlPlane({
        event: "collector.ingest.cursor.committed",
        runId,
        sessionKey: null,
        toolCallId: null,
        terminalStatus,
        cursorSegment: cursor.segment,
        cursorOffset: cursor.offset,
      });
    } catch (error) {
      const summary = toErrorSummary(error);
      logControlPlane({
        level: "warn",
        event: "collector.ingest.cursor.commit_failed",
        runId,
        sessionKey: null,
        toolCallId: null,
        terminalStatus,
        errorCode: summary.errorCode,
        message: summary.errorMessage,
      });
    } finally {
      ingestCursorByRunId.delete(runId);
    }
  };

  const appendTerminalActionRecord = async (input: {
    runId: string;
    sessionKey: string;
    actionType: "assistant_final" | "assistant_aborted" | "assistant_error";
    ts: string;
  }): Promise<void> => {
    try {
      const record = await timelineStore.appendAction({
        sessionKey: input.sessionKey,
        uid: `${input.runId}:${input.actionType}`,
        ts: input.ts,
        loggedAt: input.ts,
        actionType: input.actionType,
        runId: input.runId,
      });
      if (typeof record.timelineOffset === "number") {
        try {
          await watermarkStore.applyTerminalRecord({
            sessionKey: input.sessionKey,
            actionType: input.actionType,
            offset: record.timelineOffset,
          });
        } catch (error) {
          const summary = toErrorSummary(error);
          logControlPlane({
            level: "warn",
            event: "watermark.apply.failed",
            runId: input.runId,
            sessionKey: input.sessionKey,
            toolCallId: null,
            errorCode: summary.errorCode,
            message: summary.errorMessage,
          });
        }
      }
    } catch (error) {
      const summary = toErrorSummary(error);
      logControlPlane({
        level: "warn",
        event: "timeline.append.failed",
        runId: input.runId,
        sessionKey: input.sessionKey,
        toolCallId: null,
        errorCode: summary.errorCode,
        message: summary.errorMessage,
      });
    }
  };

  const selectLatestCursor = (items: CollectorIngestPending[]): Cursor => {
    if (items.length === 0) {
      throw new Error("collector batch requires at least one cursor");
    }
    return items.reduce((latest, current) => {
      if (current.cursor.segment > latest.segment) {
        return current.cursor;
      }
      if (current.cursor.segment === latest.segment && current.cursor.offset > latest.offset) {
        return current.cursor;
      }
      return latest;
    }, items[0].cursor);
  };

  const submitCollectorIngestBatch = async (input: {
    source: "dm" | "group" | "channel" | "flusher" | "heartbeat";
    items: CollectorIngestPending[];
  }): Promise<void> => {
    if (submitPromptForCollector === undefined) {
      throw new Error("INGEST_PIPELINE_NOT_READY");
    }
    if (
      input.items.length > 1 &&
      input.items.some((entry) => entry.projection.rawEvent.kind === "notification")
    ) {
      for (const item of input.items) {
        await submitCollectorIngestBatch({
          source: input.source,
          items: [item],
        });
      }
      return;
    }
    const payload = buildCollectorDispatchPayload(input.items.map((entry) => entry.projection));
    const latestCursor = selectLatestCursor(input.items);
    const replayed = input.items.every((entry) => entry.replayed);
    const result = await submitPromptForCollector({
      sessionKey: payload.sessionKey,
      message: payload.message,
      idempotencyKey: payload.idempotencyKey,
    });
    if (input.items.length === 1 && input.items[0]?.projection.rawEvent.kind === "notification") {
      const event = input.items[0].projection.rawEvent;
      const detail = event.detail;
      const slack =
        detail !== undefined && typeof detail === "object" && detail !== null && "slack" in detail
          ? (detail as { slack?: unknown }).slack
          : undefined;
      const slackRecord =
        typeof slack === "object" && slack !== null && !Array.isArray(slack)
          ? (slack as Record<string, unknown>)
          : {};
      notificationRunContextByRunId.set(result.accepted.runId, {
        sessionKey: payload.sessionKey,
        notificationUid: event.uid,
        title: typeof slackRecord.title === "string" ? slackRecord.title : undefined,
        originalMessageText:
          typeof slackRecord.message_text === "string"
            ? slackRecord.message_text
            : (event.subject ?? ""),
        permalink: typeof slackRecord.permalink === "string" ? slackRecord.permalink : undefined,
        teamId: typeof slackRecord.team_id === "string" ? slackRecord.team_id : undefined,
        channelId: typeof slackRecord.channel_id === "string" ? slackRecord.channel_id : undefined,
      });
    }
    const run = runLifecycle.runs().get(result.accepted.runId);
    if (run?.status === "completed" || run?.status === "failed") {
      await ingestInboxStore.commitThrough(latestCursor);
    } else {
      ingestCursorByRunId.set(result.accepted.runId, latestCursor);
    }
    logControlPlane({
      event: "collector.ingest.run.accepted",
      runId: result.accepted.runId,
      sessionKey: payload.sessionKey,
      toolCallId: null,
      collectorMessageId: input.items[0]?.request.messageId,
      collectorDedupeKey: payload.dedupeSummary,
      collectorEventKind: payload.eventKind,
      source: input.source,
      replayed,
      batchItemCount: payload.itemCount,
      idempotency: result.idempotency,
    });
  };

  const proactiveIngress = createProactiveIngressService<CollectorIngestPending>({
    globalQueue,
    onWarn: (message, meta) => {
      logControlPlane({
        level: "warn",
        event: "proactive.warn",
        message,
        runId: null,
        sessionKey: typeof meta?.sessionKey === "string" ? meta.sessionKey : null,
        toolCallId: null,
        details: meta,
      });
    },
    onSystemEvent: (event) => {
      logControlPlane({
        event: "collector.ingest.note",
        runId: null,
        sessionKey: event.sessionKey,
        toolCallId: null,
        reason: event.reason,
        itemCount: event.itemCount,
      });
    },
    dispatch: async (dispatch) => {
      await submitCollectorIngestBatch({
        source: dispatch.source,
        items: dispatch.items.map((entry) => entry.payload),
      });
    },
  });

  const processRpcServer = new ProcessRpcServer({
    ingestHandler: new CollectorIngestHandler({
      idempotencyStore,
      onAccept: async (projection, request) => {
        const cursor = await ingestInboxStore.append({
          request,
          projection,
        });
        try {
          await timelineStore.appendEvent({
            sessionKey: projection.sessionKey,
            uid: projection.rawEvent.uid,
            ts: projection.rawEvent.ts,
            loggedAt: new Date().toISOString(),
            event: projection.rawEvent,
          });
        } catch (error) {
          const summary = toErrorSummary(error);
          logControlPlane({
            level: "warn",
            event: "timeline.append.failed",
            runId: null,
            sessionKey: projection.sessionKey,
            toolCallId: null,
            errorCode: summary.errorCode,
            message: summary.errorMessage,
          });
        }
        await proactiveIngress.ingest({
          sessionKey: projection.sessionKey,
          event: projection.rawEvent,
          payload: {
            request,
            projection,
            cursor,
            replayed: false,
          },
        });
      },
    }),
    deliverHandler: new DeliverEnqueueHandler({
      onAccept: async (request) => {
        const dispatch = await deliverQueueCoordinator.accept(request);
        logControlPlane({
          event: "deliver.enqueue.accepted",
          runId: null,
          sessionKey: null,
          toolCallId: null,
          deliverMessageId: request.messageId,
          deliverDedupeKey: request.dedupeKey,
          deliverTarget: request.target,
          attempt: request.attempt,
          maxAttempts: request.maxAttempts,
          cursorSegment: dispatch.cursor.segment,
          cursorOffset: dispatch.cursor.offset,
          dispatchStatus: dispatch.dispatchStatus,
          dispatchMessage: dispatch.dispatchMessage,
        });
      },
    }),
  });

  const handleDeliverCompleted = async (
    notification: DeliverCompletedNotification
  ): Promise<void> => {
    const completion = await deliverQueueCoordinator.applyCompletion(notification);
    await deliverCompletionStore.persist();
    logControlPlane({
      event: "deliver.completed.received",
      runId: null,
      sessionKey: null,
      toolCallId: null,
      deliverMessageId: notification.messageId,
      status: notification.status,
      applied: completion.applied.applied,
      duplicate: completion.applied.duplicate,
      cursorCommitted: completion.cursorCommitted,
    });
  };

  const replayPendingDeliverQueue = async (): Promise<void> => {
    await replayPendingRecords({
      source: deliverQueueStore,
      apply: async (replay) => {
        const completed = deliverCompletionStore.get(replay.value.request.messageId);
        if (completed !== undefined) {
          await deliverQueueStore.commitThrough(replay.cursor);
          logControlPlane({
            event: "deliver.enqueue.replayed",
            runId: null,
            sessionKey: null,
            toolCallId: null,
            deliverMessageId: replay.value.request.messageId,
            deliverDedupeKey: replay.value.request.dedupeKey,
            deliverTarget: replay.value.request.target,
            cursorSegment: replay.cursor.segment,
            cursorOffset: replay.cursor.offset,
            replaySkipped: "already_completed",
          });
          return;
        }

        deliverQueueCoordinator.trackCursor(replay.value.request.messageId, replay.cursor);
        let dispatchStatus: "skipped" | "accepted" | "failed" = "skipped";
        let dispatchMessage: string | undefined;
        if (deliverSupervisor !== undefined) {
          try {
            await deliverSupervisor.enqueue(replay.value.request, { timeoutMs: 5_000 });
            dispatchStatus = "accepted";
          } catch (error) {
            dispatchStatus = "failed";
            dispatchMessage = error instanceof Error ? error.message : String(error);
          }
        }
        logControlPlane({
          event: "deliver.enqueue.replayed",
          runId: null,
          sessionKey: null,
          toolCallId: null,
          deliverMessageId: replay.value.request.messageId,
          deliverDedupeKey: replay.value.request.dedupeKey,
          deliverTarget: replay.value.request.target,
          cursorSegment: replay.cursor.segment,
          cursorOffset: replay.cursor.offset,
          dispatchStatus,
          dispatchMessage,
        });
      },
    });
  };

  deliverSupervisor = deliverConfig.deliverEnabled
    ? new DeliverSupervisor({
        command: process.execPath,
        args: ["--import", "tsx", deliverConfig.deliverEntry],
        cwd: projectRoot,
        env: process.env,
        maxRestarts: 3,
        restartDelayMs: 100,
        requestTimeoutMs: 5_000,
        onCompleted: (notification) => {
          void handleDeliverCompleted(notification).catch((error) => {
            const summary = toErrorSummary(error);
            logControlPlane({
              level: "warn",
              event: "deliver.completed.apply_failed",
              runId: null,
              sessionKey: null,
              toolCallId: null,
              errorCode: summary.errorCode,
              message: summary.errorMessage,
            });
          });
        },
        onLog: (entry) => {
          logControlPlane({
            level: entry.level === "error" ? "error" : entry.level === "warn" ? "warn" : "info",
            event: "deliver_supervisor.log",
            message: typeof entry.message === "string" ? entry.message : undefined,
            runId: null,
            sessionKey: null,
            toolCallId: null,
            details: entry,
          });
        },
      })
    : undefined;
  const collectorSupervisor = collectorConfig.collectorEnabled
    ? new CollectorSupervisor({
        command: process.execPath,
        args: ["--import", "tsx", collectorConfig.collectorEntry],
        cwd: projectRoot,
        env: process.env,
        processRpcServer,
        maxRestarts: 3,
        restartDelayMs: 100,
        requestTimeoutMs: 5000,
        onLog: (entry) => {
          logControlPlane({
            level: entry.level === "error" ? "error" : entry.level === "warn" ? "warn" : "info",
            event: "collector_supervisor.log",
            message: typeof entry.message === "string" ? entry.message : undefined,
            runId: null,
            sessionKey: null,
            toolCallId: null,
            details: entry,
          });
        },
      })
    : undefined;
  await supervisor.start();
  const initialized = await supervisor.request(
    "initialize",
    { protocolVersion: 1 },
    { timeoutMs: 5000 }
  );
  const loadSessionCapability =
    typeof initialized.agentCapabilities === "object" &&
    initialized.agentCapabilities !== null &&
    (initialized.agentCapabilities as Record<string, unknown>).loadSession === true;

  const maybeRunSummaryBatch = async (input: {
    runId: string;
    sessionKey: string;
  }): Promise<void> => {
    if (summaryBatchService === undefined) {
      return;
    }
    if (!isPhaseBEnabledForSession(phaseBRolloutScope, input.sessionKey)) {
      return;
    }
    try {
      const result = await summaryBatchService.runOnce();
      agentAuditLog.appendSummaryBatch({
        runId: input.runId,
        sessionKey: input.sessionKey,
        status: "ok",
        processedSessions: result.processedSessions,
        writtenEntries: result.writtenEntries,
        skippedEntries: result.skippedEntries,
        warnings: result.warnings,
      });
      logControlPlane({
        event: "summary_batch.completed",
        runId: input.runId,
        sessionKey: input.sessionKey,
        toolCallId: null,
        processedSessions: result.processedSessions,
        writtenEntries: result.writtenEntries,
        skippedEntries: result.skippedEntries,
        warnings: result.warnings,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      agentAuditLog.appendSummaryBatch({
        runId: input.runId,
        sessionKey: input.sessionKey,
        status: "error",
        error: message,
      });
      logControlPlane({
        level: "warn",
        event: "summary_batch.failed",
        runId: input.runId,
        sessionKey: input.sessionKey,
        toolCallId: null,
        message,
      });
    }
  };

  const submitPrompt = async (input: SubmitPromptInput): Promise<SubmitPromptResult> => {
    await sessionThreadCoordinator.ensureThreadForSession(input.sessionKey);
    const origin = input.origin ?? "user";
    const isHeartbeat = input.isHeartbeat === true;
    const memoryScope = input.memoryScope ?? threadRepository.resolveMemoryScope(input.sessionKey);
    const recordHistory = input.recordHistory ?? true;

    const requestHash = toCommandRequestHash(input.message);
    if (input.idempotencyKey !== undefined) {
      const idempotency = runLifecycle.resolveIdempotency(
        input.sessionKey,
        input.idempotencyKey,
        requestHash
      );
      if (idempotency.kind === "duplicate") {
        const sessionId = runLifecycle.runs().get(idempotency.accepted.runId)?.sessionId;
        return {
          accepted: idempotency.accepted,
          sessionId: sessionId ?? "",
          idempotency: "duplicate" as const,
        };
      }
      if (idempotency.kind === "conflict") {
        throw new Error(`IDEMPOTENCY_CONFLICT: ${idempotency.message}`);
      }

      const persisted = idempotencyStore.resolveCommand(
        input.sessionKey,
        input.idempotencyKey,
        requestHash
      );
      if (persisted.kind === "duplicate") {
        runLifecycle.bindIdempotency(
          input.sessionKey,
          input.idempotencyKey,
          requestHash,
          persisted.accepted
        );
        const sessionId = runLifecycle.runs().get(persisted.accepted.runId)?.sessionId;
        return {
          accepted: persisted.accepted,
          sessionId: sessionId ?? "",
          idempotency: "duplicate" as const,
        };
      }
      if (persisted.kind === "conflict") {
        throw new Error(`IDEMPOTENCY_CONFLICT: ${persisted.message}`);
      }
    }

    const session = await resolveOrCreateSession(input.sessionKey, {
      sessionsByKey: runLifecycle.sessions(),
      recoveryStore,
      isLoadSessionEnabled: loadSessionCapability,
      requestWorker: async (method, params) => {
        const requestParams = method === "session/new" ? { cwd: workspaceDir, ...params } : params;
        return await supervisor.request(method, requestParams, { timeoutMs: 5000 });
      },
    });

    const accepted: AcceptedResponse = runLifecycle.beginRun(input.sessionKey, session, {
      sessionRecovered: session.sessionRecovered,
      sessionRecoveryMode: session.recoveryMode,
      sessionRecoveryReason: session.fallbackReason,
    });
    runLifecycle.bindIdempotency(input.sessionKey, input.idempotencyKey, requestHash, accepted);
    if (input.idempotencyKey !== undefined) {
      await idempotencyStore.bindCommand({
        sessionKey: input.sessionKey,
        idempotencyKey: input.idempotencyKey,
        requestHash,
        accepted,
      });
    }
    // Ensure per-run buffer exists before worker notifications arrive (POST->SSE race).
    runEventBuffer.ensureRun(accepted.runId, input.sessionKey);
    if (recordHistory) {
      chatHistoryStore.appendUserMessage({
        sessionKey: input.sessionKey,
        runId: accepted.runId,
        message: input.message,
        timestamp: accepted.acceptedAt,
      });
    }
    agentAuditLog.appendRunStart({
      runId: accepted.runId,
      sessionKey: input.sessionKey,
      sessionId: session.sessionId,
    });
    if (session.recoveryMode === "fallback_new_session") {
      logControlPlane({
        level: "warn",
        event: "session.new_fallback",
        runId: accepted.runId,
        sessionKey: input.sessionKey,
        toolCallId: null,
        message: session.fallbackReason ?? "session/load fallback to session/new",
        sessionId: session.sessionId,
      });
    }
    logControlPlane({
      event: "run.accepted",
      runId: accepted.runId,
      sessionKey: input.sessionKey,
      toolCallId: null,
      sessionId: session.sessionId,
      sessionRecoveryMode: accepted.sessionRecoveryMode ?? null,
      sessionRecovered: accepted.sessionRecovered ?? null,
    });
    emitSse("run/accepted", { ...accepted, sessionId: session.sessionId });

    void (async () => {
      runLifecycle.markRunning(accepted.runId);

      try {
        const result = await supervisor.request(
          "session/prompt",
          {
            sessionId: session.sessionId,
            prompt: input.message,
            meta: {
              sessionKey: input.sessionKey,
              memoryScope,
              memoryWriteEnabled: false,
              origin,
              isHeartbeat,
            },
          },
          { timeoutMs: 5 * 60 * 1000 }
        );

        const runBeforeCompletion = runLifecycle.runs().get(accepted.runId);
        if (runBeforeCompletion?.status === "cancelled") {
          clearRunAccumulators(accepted.runId);
          return;
        }
        const stopReason = typeof result.stopReason === "string" ? result.stopReason : "end_turn";
        const done = runLifecycle.completeRun(accepted.runId, stopReason);
        if (done === undefined) {
          return;
        }
        const text = typeof result.text === "string" ? result.text : "";
        const notificationContext = notificationRunContextByRunId.get(accepted.runId);
        if (notificationContext !== undefined) {
          const toolCalls = runToolCallAccum.get(accepted.runId)?.values();
          const decision = parseNotificationDecision(text, { toolCalls });
          try {
            await timelineStore.appendEvent({
              sessionKey: notificationContext.sessionKey,
              uid: `${notificationContext.notificationUid}:decision:${accepted.runId}`,
              ts: done.finishedAt ?? new Date().toISOString(),
              loggedAt: done.finishedAt ?? new Date().toISOString(),
              event: {
                schema: "adjutant.event.v1.1",
                uid: `${notificationContext.notificationUid}:decision:${accepted.runId}`,
                source: "slack",
                kind: "notification_decision",
                subject: decision.reason ?? decision.reviewNotes ?? decision.replyText ?? "",
                ts: done.finishedAt ?? new Date().toISOString(),
                meta: {
                  notificationUid: notificationContext.notificationUid,
                  action: decision.action,
                  reason: decision.reason,
                  replyText: decision.replyText,
                  reviewNotes: decision.reviewNotes,
                  originalMessageText: notificationContext.originalMessageText,
                  title: notificationContext.title,
                  permalink: notificationContext.permalink,
                  teamId: notificationContext.teamId,
                  channelId: notificationContext.channelId,
                  runId: accepted.runId,
                },
              },
            });
          } catch (error) {
            const summary = toErrorSummary(error);
            logControlPlane({
              level: "warn",
              event: "timeline.notification_decision.append_failed",
              runId: accepted.runId,
              sessionKey: notificationContext.sessionKey,
              toolCallId: null,
              errorCode: summary.errorCode,
              message: summary.errorMessage,
            });
          } finally {
            notificationRunContextByRunId.delete(accepted.runId);
          }
        }
        runEventBuffer.append(
          accepted.runId,
          mapPromptResultToChatStreamEvent({
            runId: accepted.runId,
            sessionKey: input.sessionKey,
            text,
          })
        );
        const accumulatedThinking = runThinkingAccum.get(accepted.runId);
        const accumulatedToolCalls = runToolCallAccum.get(accepted.runId);
        if (recordHistory) {
          chatHistoryStore.appendAssistantMessage({
            sessionKey: input.sessionKey,
            runId: accepted.runId,
            message: text,
            thinking: accumulatedThinking,
            toolCalls: accumulatedToolCalls ? [...accumulatedToolCalls.values()] : undefined,
            timestamp: done.finishedAt ?? new Date().toISOString(),
          });
        }
        clearRunAccumulators(accepted.runId);
        emitSse("run/completed", {
          runId: accepted.runId,
          sessionId: session.sessionId,
          stopReason: done.stopReason,
          text,
        });
        agentAuditLog.appendRunEnd({
          runId: accepted.runId,
          sessionKey: input.sessionKey,
          status: "ok",
          stopReason: done.stopReason,
        });
        logControlPlane({
          event: "run.completed",
          runId: accepted.runId,
          sessionKey: input.sessionKey,
          toolCallId: null,
          stopReason: done.stopReason,
        });
        await appendTerminalActionRecord({
          runId: accepted.runId,
          sessionKey: input.sessionKey,
          actionType: "assistant_final",
          ts: done.finishedAt ?? new Date().toISOString(),
        });
        await commitIngestCursorForRun(accepted.runId, "completed");
        if (origin === "user" && !isHeartbeat) {
          await maybeRunSummaryBatch({
            runId: accepted.runId,
            sessionKey: input.sessionKey,
          });
        }
      } catch (error) {
        notificationRunContextByRunId.delete(accepted.runId);
        const runBeforeFailure = runLifecycle.runs().get(accepted.runId);
        if (runBeforeFailure?.status === "cancelled") {
          clearRunAccumulators(accepted.runId);
          return;
        }

        const summary = toErrorSummary(error);
        const failed = runLifecycle.failRun(accepted.runId, summary);
        if (failed === undefined) {
          return;
        }
        runEventBuffer.append(
          accepted.runId,
          mapRunFailureToChatStreamEvent({
            runId: accepted.runId,
            sessionKey: input.sessionKey,
            summary,
          })
        );
        emitSse("run/failed", {
          runId: accepted.runId,
          sessionId: session.sessionId,
          errorCode: summary.errorCode,
          errorMessage: summary.errorMessage,
        });
        agentAuditLog.appendRunEnd({
          runId: accepted.runId,
          sessionKey: input.sessionKey,
          status: "error",
          error: summary.errorMessage,
        });
        logControlPlane({
          level: "warn",
          event: "run.failed",
          runId: accepted.runId,
          sessionKey: input.sessionKey,
          toolCallId: null,
          errorCode: summary.errorCode,
          message: summary.errorMessage,
        });
        await appendTerminalActionRecord({
          runId: accepted.runId,
          sessionKey: input.sessionKey,
          actionType: "assistant_error",
          ts: failed.finishedAt ?? new Date().toISOString(),
        });
        await commitIngestCursorForRun(accepted.runId, "failed");
      } finally {
        const finalRun = runLifecycle.runs().get(accepted.runId);
        if (finalRun?.status === "cancelled") {
          await appendTerminalActionRecord({
            runId: accepted.runId,
            sessionKey: input.sessionKey,
            actionType: "assistant_aborted",
            ts: finalRun.finishedAt ?? new Date().toISOString(),
          });
          await commitIngestCursorForRun(accepted.runId, "cancelled");
        }
        clearRunAccumulators(accepted.runId);
        clearPermissionRequestRun(accepted.runId);
        runLifecycle.clearActiveSessionRun(session.sessionId);
        await sessionThreadCoordinator.persistSessionRecovery({
          runId: accepted.runId,
          sessionKey: input.sessionKey,
          sessionId: session.sessionId,
          lastRunId: accepted.runId,
        });
      }
    })();

    return {
      accepted,
      sessionId: session.sessionId,
      idempotency: "miss" as const,
    };
  };
  submitPromptForCollector = submitPrompt;

  const flusherEnabled = parseBoolean(process.env.ADJUTANT_FLUSHER_ENABLED, true);
  const flusherIntervalMs = parsePositiveInt(process.env.ADJUTANT_FLUSHER_INTERVAL_MS, 60_000);
  const flusherStaleMs = parsePositiveInt(process.env.ADJUTANT_FLUSHER_STALE_MS, 900_000);
  const pendingFlusher = createPendingFlusher({
    timelinePath: timelineStore.pathForDebug(),
    watermarkStore,
    staleMs: flusherStaleMs,
    enqueueSession: async ({ sessionKey, reason, openPostCount }) => {
      const lease = await globalQueue.acquire("flusher");
      try {
        const idempotencyWindow = Math.floor(Date.now() / flusherStaleMs);
        try {
          const result = await submitPrompt({
            sessionKey,
            origin: "system",
            isHeartbeat: false,
            recordHistory: false,
            idempotencyKey: `flusher:${sessionKey}:${idempotencyWindow}`,
            message: `[Flusher] reason=${reason} openPostCount=${openPostCount}. Please inspect stale pending posts and decide if user follow-up is needed.`,
          });
          logControlPlane({
            event: "flusher.enqueue.accepted",
            runId: result.accepted.runId,
            sessionKey,
            toolCallId: null,
            reason,
            openPostCount,
          });
        } catch (error) {
          const summary = toErrorSummary(error);
          logControlPlane({
            level: "warn",
            event: "flusher.enqueue.failed",
            runId: null,
            sessionKey,
            toolCallId: null,
            reason,
            openPostCount,
            errorCode: summary.errorCode,
            message: summary.errorMessage,
          });
        }
      } finally {
        lease.release();
      }
    },
  });
  let flusherTickInFlight = false;
  let flusherTimer: ReturnType<typeof setInterval> | undefined;
  const runFlusherTick = async (trigger: "startup" | "periodic"): Promise<void> => {
    if (!flusherEnabled || flusherTickInFlight) {
      return;
    }
    flusherTickInFlight = true;
    try {
      const result = await pendingFlusher.tick();
      logControlPlane({
        event: "flusher.tick.completed",
        runId: null,
        sessionKey: null,
        toolCallId: null,
        trigger,
        firedSessionKeys: result.firedSessionKeys,
        suppressedSessionKeys: result.suppressedSessionKeys,
        scannedRecords: result.scannedRecords,
      });
    } catch (error) {
      const summary = toErrorSummary(error);
      logControlPlane({
        level: "warn",
        event: "flusher.tick.failed",
        runId: null,
        sessionKey: null,
        toolCallId: null,
        trigger,
        errorCode: summary.errorCode,
        message: summary.errorMessage,
      });
    } finally {
      flusherTickInFlight = false;
    }
  };
  const startPendingFlusher = (): void => {
    if (!flusherEnabled || flusherTimer !== undefined) {
      return;
    }
    flusherTimer = setInterval(() => {
      void runFlusherTick("periodic");
    }, flusherIntervalMs);
  };
  const stopPendingFlusher = (): void => {
    if (flusherTimer === undefined) {
      return;
    }
    clearInterval(flusherTimer);
    flusherTimer = undefined;
  };

  const heartbeatEnabled = parseBoolean(process.env.ADJUTANT_HEARTBEAT_ENABLED, true);
  const heartbeatIntervalMs = parsePositiveInt(
    process.env.ADJUTANT_HEARTBEAT_INTERVAL_MS,
    1_800_000
  );
  const heartbeatTimeoutMs = parsePositiveInt(process.env.ADJUTANT_HEARTBEAT_TIMEOUT_MS, 30_000);
  const heartbeatPromptPath =
    process.env.ADJUTANT_HEARTBEAT_FILE_PATH?.trim() || join(workspaceDir, "HEARTBEAT.md");
  const heartbeatRunner = createHeartbeatRunner({
    intervalMs: heartbeatIntervalMs,
    timeoutMs: heartbeatTimeoutMs,
    readPrompt: async () => await readFile(heartbeatPromptPath, "utf8"),
    beforeRun: async () => {
      const session = runLifecycle.sessions().get("main");
      if (session === undefined) {
        return null;
      }
      const runId = runLifecycle.resolveRunId(session.sessionId);
      if (runId !== undefined) {
        return { skipReason: "session-busy" };
      }
      return null;
    },
    executePrompt: async ({ prompt, timeoutMs }) => {
      const session = await resolveOrCreateSession("main", {
        sessionsByKey: runLifecycle.sessions(),
        recoveryStore,
        isLoadSessionEnabled: loadSessionCapability,
        requestWorker: async (method, params) => {
          const requestParams =
            method === "session/new" ? { cwd: workspaceDir, ...params } : params;
          return await supervisor.request(method, requestParams, { timeoutMs: 5_000 });
        },
      });
      const observedToolCalls = new Map<string, Record<string, unknown>>();
      const unsubscribe = subscribeSessionUpdates(session.sessionId, (update) => {
        const updateType = typeof update.sessionUpdate === "string" ? update.sessionUpdate : "";
        if (updateType !== "tool_call" && updateType !== "tool_call_update") {
          return;
        }
        const toolCallId =
          typeof update.toolCallId === "string" && update.toolCallId.length > 0
            ? update.toolCallId
            : `heartbeat:${Date.now()}`;
        const existing = observedToolCalls.get(toolCallId) ?? {};
        if (typeof update.title === "string" && update.title.length > 0) {
          existing.toolName = update.title;
        } else if (typeof update.kind === "string" && update.kind.length > 0) {
          existing.toolName = update.kind;
        }
        if (typeof update.status === "string") {
          existing.status = update.status;
        }
        if ("rawInput" in update) {
          existing.rawInput = update.rawInput;
        }
        if ("rawOutput" in update) {
          existing.rawOutput = update.rawOutput;
        }
        existing.toolCallId = toolCallId;
        observedToolCalls.set(toolCallId, existing);
      });
      try {
        const result = await supervisor.request(
          "session/prompt",
          {
            sessionId: session.sessionId,
            prompt,
            meta: {
              sessionKey: "main",
              memoryScope: "main",
              memoryWriteEnabled: false,
              origin: "system",
              isHeartbeat: true,
            },
          },
          { timeoutMs }
        );
        const runId = typeof result.runId === "string" ? result.runId : undefined;
        const text = typeof result.text === "string" ? result.text : undefined;
        return {
          runId,
          text,
          toolCalls: [...observedToolCalls.values()].map((entry) => ({
            toolCallId: typeof entry.toolCallId === "string" ? entry.toolCallId : undefined,
            toolName: typeof entry.toolName === "string" ? entry.toolName : undefined,
            status: typeof entry.status === "string" ? entry.status : undefined,
            rawInput: entry.rawInput,
            rawOutput: entry.rawOutput,
          })),
        };
      } finally {
        unsubscribe();
      }
    },
    globalQueue,
    resultStore: heartbeatResultStore,
    recordMeaningfulText: async ({ runId, text, reason }) => {
      chatHistoryStore.appendAssistantMessage({
        sessionKey: "main",
        runId: runId ?? `heartbeat:${Date.now()}`,
        message: `[Heartbeat:${reason}] ${text}`,
        timestamp: new Date().toISOString(),
      });
    },
    emitEvent: (result) => {
      emitSse("heartbeat", result as unknown as Record<string, unknown>);
      logControlPlane({
        event: "heartbeat.run.completed",
        runId: typeof result.runId === "string" ? result.runId : null,
        sessionKey: "main",
        toolCallId: null,
        status: result.status,
        heartbeatEventStatus: result.event.status,
        reason: result.event.reason,
      });
    },
    onWarn: (message, meta) => {
      logControlPlane({
        level: "warn",
        event: "heartbeat.warn",
        message,
        runId: null,
        sessionKey: "main",
        toolCallId: null,
        details: meta,
      });
    },
  });

  await replayPendingRecords({
    source: ingestInboxStore,
    apply: async (replay) => {
      await proactiveIngress.ingest({
        sessionKey: replay.value.projection.sessionKey,
        event: replay.value.projection.rawEvent,
        payload: {
          request: replay.value.request,
          projection: replay.value.projection,
          cursor: replay.cursor,
          replayed: true,
        },
      });
    },
  });

  if (collectorSupervisor !== undefined) {
    await collectorSupervisor.start();
  }
  if (deliverSupervisor !== undefined) {
    await deliverSupervisor.start();
  }
  await replayPendingDeliverQueue();
  if (heartbeatEnabled) {
    heartbeatRunner.start();
  }
  if (flusherEnabled) {
    startPendingFlusher();
    void runFlusherTick("startup");
  }

  const buildThreadSnapshot = (threadId: string): ThreadSnapshotResponse | undefined => {
    const thread = threadRepository.getOrVirtual(threadId);
    if (thread === undefined) {
      return undefined;
    }

    const runs = [...runLifecycle.runs().values()]
      .filter((run) => run.sessionKey === threadId)
      .sort((a, b) => a.acceptedAt.localeCompare(b.acceptedAt));
    const sessionIds = new Set(
      runs
        .map((run) => run.sessionId)
        .filter((sessionId): sessionId is string => {
          return typeof sessionId === "string";
        })
    );

    const toolEventsByRun: ThreadSnapshotResponse["toolEventsByRun"] = {};
    for (const run of runs) {
      const records = uiRuntime
        .listToolEvents(run.runId)
        .map((record) => {
          if (record.status === undefined) {
            return null;
          }
          return {
            runId: record.runId,
            sessionId: record.sessionId,
            toolCallId: record.toolCallId,
            status: record.status,
            title: record.title,
            kind: record.kind,
            rawInput: record.rawInput,
            rawOutput: record.rawOutput,
            error: record.error,
            updatedAt: record.updatedAt,
          };
        })
        .filter((record): record is NonNullable<typeof record> => record !== null);
      if (records.length > 0) {
        toolEventsByRun[run.runId] = records;
      }
    }

    const pendingPermissions = permissionGateway
      .listPending()
      // pending permission は process 内メモリ状態のみを正本としており、
      // thread -> runs -> sessionId の現行 in-memory 関係でスコープを絞る。
      .filter((permission) => sessionIds.has(permission.sessionId))
      .map(toPermissionSummary);

    return {
      thread,
      runs,
      toolEventsByRun,
      pendingPermissions,
    };
  };

  const controlPlaneHandler = createControlPlaneRequestHandler({
    sseHub,
    renderRootPage: () => renderMinimalUiPage(),
    buildSnapshot: () =>
      buildSnapshotResponse({
        runById: runLifecycle.runs(),
        listToolEvents: (runId) => uiRuntime.listToolEvents(runId),
        listPendingPermissions: () => permissionGateway.listPending(),
      }),
    submitPrompt,
    readRunAudit: async (runId) => await readRunAudit(runId, agentAuditLog),
    runLifecycle,
    runEventBuffer,
    chatHistoryStore,
    threadRepository,
    buildThreadSnapshot,
    supervisor,
    permissionGateway,
    runHeartbeat: heartbeatEnabled
      ? async (reason) => await heartbeatRunner.runOnce(reason)
      : undefined,
    getLastHeartbeat: heartbeatEnabled ? () => heartbeatRunner.getLast() : undefined,
    listHeartbeatHistory: heartbeatEnabled
      ? (input): GetHeartbeatHistoryResponse => heartbeatRunner.getHistory(input)
      : undefined,
    buildActivityFeed: createActivityFeedReader(timelineStore),
  });

  const server = createServer((req, res) => {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const isApiRequest = url.pathname.startsWith("/api/");

    if (!isApiRequest && method === "GET" && viteDevServer !== undefined) {
      viteDevServer.middlewares(req, res, (error: unknown) => {
        if (error != null) {
          const summary = toErrorSummary(error);
          res.statusCode = 500;
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.end(
            JSON.stringify({
              code: summary.errorCode,
              message: summary.errorMessage,
            })
          );
          return;
        }
        void controlPlaneHandler(req, res);
      });
      return;
    }

    void controlPlaneHandler(req, res);
  });

  const host = process.env.ADJUTANT_CONTROL_PLANE_HOST ?? "127.0.0.1";
  const port = Number(process.env.ADJUTANT_CONTROL_PLANE_PORT ?? "3100");

  await new Promise<void>((resolveListen) => {
    server.listen(port, host, () => {
      process.stdout.write(`[control-plane] listening on http://${host}:${port}\n`);
      logControlPlane({
        event: "server.listening",
        runId: null,
        sessionKey: null,
        toolCallId: null,
        host,
        port,
        phaseBRolloutScope,
        sandboxMode: sandboxRuntime.mode,
        sandboxEnabled: sandboxRuntime.enabled,
        summaryBatchEnabled,
      });
      resolveListen();
    });
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logControlPlane({
      event: "server.shutdown.start",
      runId: null,
      sessionKey: null,
      toolCallId: null,
    });

    sseHub.closeAll();

    await new Promise<void>((resolveClose) => {
      server.close(() => resolveClose());
    });
    if (collectorSupervisor !== undefined) {
      await collectorSupervisor.stop();
    }
    if (deliverSupervisor !== undefined) {
      await deliverSupervisor.stop();
    }
    stopPendingFlusher();
    heartbeatRunner.stop();
    await supervisor.stop();
    if (viteDevServer !== undefined) {
      await viteDevServer.close();
    }
    await agentAuditLog.flush();
    await sandboxRuntime.dispose();
    logControlPlane({
      event: "server.shutdown.done",
      runId: null,
      sessionKey: null,
      toolCallId: null,
    });
  };

  const shutdownSignals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const signal of shutdownSignals) {
    process.on(signal, () => {
      void shutdown();
    });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
