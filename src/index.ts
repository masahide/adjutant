import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer, type ViteDevServer } from "vite";

import { createMarkdownSummaryBatchService } from "./assistant/markdown-summary-batch.js";
import { loadCollectorSlackConfig } from "./collector-slack/config.js";
import type { CollectorIngestRequest } from "./contracts/process-rpc/method-types.js";
import type { ClientNotification } from "./contracts/acp/rpc-types.js";
import { PermissionGateway } from "./control-plane/acp/permission-gateway.js";
import { resolveOrCreateSession } from "./control-plane/acp/session-recovery-resolver.js";
import { SessionRecoveryStore } from "./control-plane/acp/session-recovery-store.js";
import { WorkerSupervisor } from "./control-plane/acp/worker-supervisor.js";
import { AgentAuditLog } from "./control-plane/audit/agent-audit-log.js";
import { readRunAudit } from "./control-plane/audit/audit-reader.js";
import {
  toPermissionSummary,
  type AcceptedResponse,
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
import { RunLifecycle } from "./control-plane/http/run-lifecycle.js";
import { RunEventBuffer } from "./control-plane/http/run-event-buffer.js";
import { SessionThreadCoordinator } from "./control-plane/http/session-thread-coordinator.js";
import { SseHub } from "./control-plane/http/sse-hub.js";
import { ThreadRepository } from "./control-plane/http/thread-repository.js";
import { writeStructuredLog } from "./control-plane/logging/structured-log.js";
import { CollectorSupervisor } from "./control-plane/process-rpc/collector-supervisor.js";
import { CollectorIngestHandler } from "./control-plane/process-rpc/ingest-handler.js";
import { IngestInboxStore } from "./control-plane/process-rpc/ingest-inbox-store.js";
import type { IngestProjection } from "./control-plane/process-rpc/ingest-projection.js";
import { ProcessRpcServer } from "./control-plane/process-rpc/server.js";
import type { Cursor } from "./runtime/journal-store.js";
import { initializeSandboxRuntime } from "./sandbox/runtime.js";
import { buildSnapshotResponse } from "./control-plane/http/snapshot-builder.js";
import { renderMinimalUiPage } from "./ui/minimal-page.js";
import { UiRuntime } from "./ui/runtime.js";

function resolveProjectRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function createWorkerSupervisor(
  cwd: string,
  stateDir: string,
  sandbox: {
    mode: "off" | "non-main" | "all";
    enabled: boolean;
    runSpec?: {
      image: string;
      hostWorkspaceDir: string;
      containerWorkdir: string;
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
    ACP_WORKER_SESSION_STORE_PATH: join(stateDir, "worker", "session-store.json"),
  };

  if (sandbox.enabled && sandbox.runSpec !== undefined) {
    workerEnv.ACP_WORKER_SANDBOX_MODE = sandbox.mode;
    workerEnv.ACP_WORKER_SANDBOX_IMAGE = sandbox.runSpec.image;
    workerEnv.ACP_WORKER_SANDBOX_HOST_WORKSPACE_DIR = sandbox.runSpec.hostWorkspaceDir;
    workerEnv.ACP_WORKER_SANDBOX_WORKDIR = sandbox.runSpec.containerWorkdir;
    workerEnv.ACP_WORKER_SANDBOX_ENV_ALLOWLIST = (sandbox.runSpec.envAllowlist ?? []).join(",");
    workerEnv.ACP_WORKER_SANDBOX_READ_ONLY_ROOT =
      sandbox.runSpec.readOnlyRoot === false ? "0" : "1";
    workerEnv.ACP_WORKER_SANDBOX_TMPFS = (sandbox.runSpec.tmpfs ?? []).join(",");
    workerEnv.ACP_WORKER_SANDBOX_CAP_DROP = (sandbox.runSpec.capDrop ?? []).join(",");
    workerEnv.ACP_WORKER_SANDBOX_NETWORK = sandbox.runSpec.network ?? "";
    workerEnv.ACP_WORKER_SANDBOX_MEMORY = sandbox.runSpec.memory ?? "";
    workerEnv.ACP_WORKER_SANDBOX_PIDS_LIMIT =
      typeof sandbox.runSpec.pidsLimit === "number" ? String(sandbox.runSpec.pidsLimit) : "";
  } else {
    workerEnv.ACP_WORKER_SANDBOX_MODE = "off";
    delete workerEnv.ACP_WORKER_SANDBOX_IMAGE;
    delete workerEnv.ACP_WORKER_SANDBOX_HOST_WORKSPACE_DIR;
    delete workerEnv.ACP_WORKER_SANDBOX_WORKDIR;
    delete workerEnv.ACP_WORKER_SANDBOX_ENV_ALLOWLIST;
    delete workerEnv.ACP_WORKER_SANDBOX_READ_ONLY_ROOT;
    delete workerEnv.ACP_WORKER_SANDBOX_TMPFS;
    delete workerEnv.ACP_WORKER_SANDBOX_CAP_DROP;
    delete workerEnv.ACP_WORKER_SANDBOX_NETWORK;
    delete workerEnv.ACP_WORKER_SANDBOX_MEMORY;
    delete workerEnv.ACP_WORKER_SANDBOX_PIDS_LIMIT;
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
};

type SubmitPromptResult = {
  accepted: AcceptedResponse;
  sessionId: string;
  idempotency: "miss" | "duplicate";
};

export async function main(): Promise<void> {
  const cwd = resolveProjectRoot();
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
    workspaceDir: cwd,
  });
  const stateDirEnv = process.env.ADJUTANT_STATE_DIR?.trim();
  const stateDir =
    stateDirEnv !== undefined && stateDirEnv.length > 0
      ? resolve(stateDirEnv)
      : resolve(homedir(), ".adjutant");
  const collectorConfig = loadCollectorSlackConfig({ env: process.env, cwd, stateDir });
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
        workspaceDir: cwd,
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
        configFile: resolve(cwd, "vite.config.ts"),
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
  const ingestInboxStore = IngestInboxStore.fromStateDir(stateDir);
  await ingestInboxStore.initialize();
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
    result?: string;
  };
  const runToolCallAccum = new Map<string, Map<string, ToolCallAccumEntry>>();
  const clearRunAccumulators = (runId: string) => {
    runThinkingAccum.delete(runId);
    runToolCallAccum.delete(runId);
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
    cwd,
    stateDir,
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

      const clientNotification: ClientNotification = {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: update as Record<string, unknown>,
        },
      };
      uiRuntime.onAcpSessionUpdate(clientNotification);

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

      const sessionUpdate = (update as Record<string, unknown>).sessionUpdate;

      // Accumulate thinking chunks for structured history content.
      if (sessionUpdate === "agent_thinking_chunk") {
        const content = (update as Record<string, unknown>).content;
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
        const title = (update as Record<string, unknown>).title;
        const kind = (update as Record<string, unknown>).kind;
        const toolCallId = (update as Record<string, unknown>).toolCallId;
        const rawInput = (update as Record<string, unknown>).rawInput;
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
        const toolCallId = (update as Record<string, unknown>).toolCallId;
        const status = (update as Record<string, unknown>).status;
        const updateTitle = (update as Record<string, unknown>).title;
        const updateKind = (update as Record<string, unknown>).kind;
        const rawOutput = (update as Record<string, unknown>).rawOutput;
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
              status === "failed" && typeof (update as Record<string, unknown>).error === "string"
                ? ((update as Record<string, unknown>).error as string)
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

      emitSse("run/update", { runId, sessionId, update: update as Record<string, unknown> });

      const mapped = mapSessionUpdateToChatStreamEvent({
        runId,
        sessionKey: run.sessionKey,
        update: update as Record<string, unknown>,
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

  const submitCollectorIngestProjection = async (input: {
    request: CollectorIngestRequest;
    projection: IngestProjection;
    cursor: Cursor;
    replayed: boolean;
  }): Promise<void> => {
    if (submitPromptForCollector === undefined) {
      throw new Error("INGEST_PIPELINE_NOT_READY");
    }
    const result = await submitPromptForCollector({
      sessionKey: input.projection.sessionKey,
      message: input.projection.message,
      idempotencyKey: input.projection.dedupeKey,
    });
    const run = runLifecycle.runs().get(result.accepted.runId);
    if (run?.status === "completed" || run?.status === "failed") {
      await ingestInboxStore.commitThrough(input.cursor);
    } else {
      ingestCursorByRunId.set(result.accepted.runId, input.cursor);
    }
    logControlPlane({
      event: "collector.ingest.run.accepted",
      runId: result.accepted.runId,
      sessionKey: input.projection.sessionKey,
      toolCallId: null,
      collectorMessageId: input.request.messageId,
      collectorDedupeKey: input.request.dedupeKey,
      collectorEventKind: input.projection.rawEvent.kind,
      source: input.request.source,
      replayed: input.replayed,
      idempotency: result.idempotency,
    });
  };

  const processRpcServer = new ProcessRpcServer({
    ingestHandler: new CollectorIngestHandler({
      onAccept: async (projection, request) => {
        const cursor = await ingestInboxStore.append({
          request,
          projection,
        });
        await submitCollectorIngestProjection({
          request,
          projection,
          cursor,
          replayed: false,
        });
      },
    }),
  });
  const collectorSupervisor = collectorConfig.collectorEnabled
    ? new CollectorSupervisor({
        command: process.execPath,
        args: ["--import", "tsx", collectorConfig.collectorEntry],
        cwd,
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

    const requestHash = toCommandRequestHash(input.message);
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

    const session = await resolveOrCreateSession(input.sessionKey, {
      sessionsByKey: runLifecycle.sessions(),
      recoveryStore,
      isLoadSessionEnabled: loadSessionCapability,
      requestWorker: async (method, params) => {
        return await supervisor.request(method, params, { timeoutMs: 5000 });
      },
    });

    const accepted: AcceptedResponse = runLifecycle.beginRun(input.sessionKey, session, {
      sessionRecovered: session.sessionRecovered,
      sessionRecoveryMode: session.recoveryMode,
      sessionRecoveryReason: session.fallbackReason,
    });
    runLifecycle.bindIdempotency(input.sessionKey, input.idempotencyKey, requestHash, accepted);
    // Ensure per-run buffer exists before worker notifications arrive (POST->SSE race).
    runEventBuffer.ensureRun(accepted.runId, input.sessionKey);
    chatHistoryStore.appendUserMessage({
      sessionKey: input.sessionKey,
      runId: accepted.runId,
      message: input.message,
      timestamp: accepted.acceptedAt,
    });
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
              memoryScope: threadRepository.resolveMemoryScope(input.sessionKey),
              memoryWriteEnabled: false,
              origin: "user",
              isHeartbeat: false,
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
        chatHistoryStore.appendAssistantMessage({
          sessionKey: input.sessionKey,
          runId: accepted.runId,
          message: text,
          thinking: accumulatedThinking,
          toolCalls: accumulatedToolCalls ? [...accumulatedToolCalls.values()] : undefined,
          timestamp: done.finishedAt ?? new Date().toISOString(),
        });
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
        await commitIngestCursorForRun(accepted.runId, "completed");
        await maybeRunSummaryBatch({
          runId: accepted.runId,
          sessionKey: input.sessionKey,
        });
      } catch (error) {
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
        await commitIngestCursorForRun(accepted.runId, "failed");
      } finally {
        const finalRun = runLifecycle.runs().get(accepted.runId);
        if (finalRun?.status === "cancelled") {
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

  const replayRecords = await ingestInboxStore.replayPending();
  for (const replay of replayRecords) {
    await submitCollectorIngestProjection({
      request: replay.value.request,
      projection: replay.value.projection,
      cursor: replay.cursor,
      replayed: true,
    });
  }

  if (collectorSupervisor !== undefined) {
    await collectorSupervisor.start();
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
