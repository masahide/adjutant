import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createMarkdownSummaryBatchService } from "./assistant/markdown-summary-batch.js";
import type { ClientNotification } from "./contracts/acp/rpc-types.js";
import { PermissionGateway } from "./control-plane/acp/permission-gateway.js";
import { resolveOrCreateSession } from "./control-plane/acp/session-recovery-resolver.js";
import { SessionRecoveryStore } from "./control-plane/acp/session-recovery-store.js";
import { WorkerSupervisor } from "./control-plane/acp/worker-supervisor.js";
import { AgentAuditLog } from "./control-plane/audit/agent-audit-log.js";
import { readRunAudit } from "./control-plane/audit/audit-reader.js";
import {
  type AcceptedResponse,
  type CommandRequest,
  type StreamEventType,
} from "./control-plane/contracts/http-api.js";
import { toErrorSummary, toHttpStatusCode } from "./control-plane/http/error-summary.js";
import { RunLifecycle } from "./control-plane/http/run-lifecycle.js";
import { SseHub } from "./control-plane/http/sse-hub.js";
import { writeStructuredLog } from "./control-plane/logging/structured-log.js";
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
  onLog: (entry: Record<string, unknown>) => void,
  onNotification: (notification: { method: string; params: Record<string, unknown> }) => void
): WorkerSupervisor {
  return new WorkerSupervisor({
    command: process.execPath,
    args: ["--import", "tsx", "src/agent-worker-acp/stdio-server.ts"],
    cwd,
    env: {
      ...process.env,
      ACP_WORKER_SESSION_STORE_PATH: join(stateDir, "worker", "session-store.json"),
    },
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

function writeJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const body = Buffer.concat(chunks).toString("utf8").trim();
  if (body.length === 0) {
    throw new Error("INVALID_REQUEST: empty body");
  }
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error("INVALID_REQUEST: malformed json body");
  }
}

function isCommandRequest(value: unknown): value is CommandRequest {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.sessionKey === "string" && typeof record.message === "string";
}

function normalizeIdempotencyKey(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toCommandRequestHash(message: string): string {
  return JSON.stringify({ message });
}

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
      : resolve(cwd, ".adjutant", "state");
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

  const runLifecycle = new RunLifecycle();
  const sseHub = new SseHub();

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
    },
  });

  const supervisor = createWorkerSupervisor(
    cwd,
    stateDir,
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
      if (run !== undefined && typeof run.sessionKey === "string") {
        const sessionUpdate = (update as Record<string, unknown>).sessionUpdate;
        if (sessionUpdate === "tool_call") {
          const title = (update as Record<string, unknown>).title;
          const kind = (update as Record<string, unknown>).kind;
          const toolCallId = (update as Record<string, unknown>).toolCallId;
          const toolName =
            typeof title === "string" && title.trim().length > 0
              ? title.trim()
              : typeof kind === "string" && kind.trim().length > 0
                ? kind.trim()
                : "tool";
          agentAuditLog.appendToolStart({
            runId,
            sessionKey: run.sessionKey,
            toolName,
            toolCallId: typeof toolCallId === "string" ? toolCallId : undefined,
            args: (update as Record<string, unknown>).rawInput,
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
          if (status === "completed" || status === "failed") {
            const toolName = "tool";
            agentAuditLog.appendToolEnd({
              runId,
              sessionKey: run.sessionKey,
              toolName,
              toolCallId: typeof toolCallId === "string" ? toolCallId : undefined,
              status: status === "completed" ? "ok" : "error",
              resultSummary: (update as Record<string, unknown>).rawOutput,
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
      }

      emitSse("run/update", { runId, sessionId, update: update as Record<string, unknown> });
    }
  );

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

  const server = createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const url = req.url ?? "/";

    if (method === "GET" && url === "/api/events/stream") {
      sseHub.addClient(req, res);
      return;
    }

    if (method === "GET" && url === "/api/snapshot") {
      const snapshot = buildSnapshotResponse({
        runById: runLifecycle.runs(),
        listToolEvents: (runId) => uiRuntime.listToolEvents(runId),
        listPendingPermissions: () => permissionGateway.listPending(),
      });
      writeJson(res, 200, snapshot);
      return;
    }

    if (method === "POST" && url === "/api/commands") {
      try {
        const payload = await readJsonBody<unknown>(req);
        if (!isCommandRequest(payload)) {
          writeJson(res, 400, {
            code: "INVALID_REQUEST",
            message: "sessionKey/message are required",
          });
          return;
        }
        const idempotencyKey = normalizeIdempotencyKey(payload.idempotencyKey);
        const requestHash = toCommandRequestHash(payload.message);
        const idempotency = runLifecycle.resolveIdempotency(
          payload.sessionKey,
          idempotencyKey,
          requestHash
        );
        if (idempotency.kind === "duplicate") {
          writeJson(res, 202, idempotency.accepted);
          return;
        }
        if (idempotency.kind === "conflict") {
          writeJson(res, 409, {
            code: "INVALID_REQUEST",
            message: idempotency.message,
          });
          return;
        }

        const session = await resolveOrCreateSession(payload.sessionKey, {
          sessionsByKey: runLifecycle.sessions(),
          recoveryStore,
          isLoadSessionEnabled: loadSessionCapability,
          requestWorker: async (method, params) => {
            return await supervisor.request(method, params, { timeoutMs: 5000 });
          },
        });

        const accepted: AcceptedResponse = runLifecycle.beginRun(payload.sessionKey, session, {
          sessionRecovered: session.sessionRecovered,
          sessionRecoveryMode: session.recoveryMode,
          sessionRecoveryReason: session.fallbackReason,
        });
        runLifecycle.bindIdempotency(payload.sessionKey, idempotencyKey, requestHash, accepted);
        agentAuditLog.appendRunStart({
          runId: accepted.runId,
          sessionKey: payload.sessionKey,
          sessionId: session.sessionId,
        });
        if (session.recoveryMode === "fallback_new_session") {
          logControlPlane({
            level: "warn",
            event: "session.new_fallback",
            runId: accepted.runId,
            sessionKey: payload.sessionKey,
            toolCallId: null,
            message: session.fallbackReason ?? "session/load fallback to session/new",
            sessionId: session.sessionId,
          });
        }
        logControlPlane({
          event: "run.accepted",
          runId: accepted.runId,
          sessionKey: payload.sessionKey,
          toolCallId: null,
          sessionId: session.sessionId,
          sessionRecoveryMode: accepted.sessionRecoveryMode ?? null,
          sessionRecovered: accepted.sessionRecovered ?? null,
        });
        writeJson(res, 202, accepted);
        emitSse("run/accepted", { ...accepted, sessionId: session.sessionId });

        void (async () => {
          runLifecycle.markRunning(accepted.runId);

          try {
            const result = await supervisor.request(
              "session/prompt",
              {
                sessionId: session.sessionId,
                prompt: payload.message,
                meta: {
                  sessionKey: payload.sessionKey,
                  memoryScope: payload.sessionKey === "main" ? "main" : "spoke",
                  memoryWriteEnabled: false,
                  origin: "user",
                  isHeartbeat: false,
                },
              },
              { timeoutMs: 5 * 60 * 1000 }
            );

            const done = runLifecycle.completeRun(
              accepted.runId,
              typeof result.stopReason === "string" ? result.stopReason : "end_turn"
            );
            if (done === undefined) {
              return;
            }

            emitSse("run/completed", {
              runId: accepted.runId,
              sessionId: session.sessionId,
              stopReason: done.stopReason,
              text: typeof result.text === "string" ? result.text : "",
            });
            agentAuditLog.appendRunEnd({
              runId: accepted.runId,
              sessionKey: payload.sessionKey,
              status: "ok",
              stopReason: done.stopReason,
            });
            logControlPlane({
              event: "run.completed",
              runId: accepted.runId,
              sessionKey: payload.sessionKey,
              toolCallId: null,
              stopReason: done.stopReason,
            });
            await maybeRunSummaryBatch({
              runId: accepted.runId,
              sessionKey: payload.sessionKey,
            });
          } catch (error) {
            const summary = toErrorSummary(error);
            const failed = runLifecycle.failRun(accepted.runId, summary);
            if (failed === undefined) {
              return;
            }

            emitSse("run/failed", {
              runId: accepted.runId,
              sessionId: session.sessionId,
              errorCode: summary.errorCode,
              errorMessage: summary.errorMessage,
            });
            agentAuditLog.appendRunEnd({
              runId: accepted.runId,
              sessionKey: payload.sessionKey,
              status: "error",
              error: summary.errorMessage,
            });
            logControlPlane({
              level: "warn",
              event: "run.failed",
              runId: accepted.runId,
              sessionKey: payload.sessionKey,
              toolCallId: null,
              errorCode: summary.errorCode,
              message: summary.errorMessage,
            });
          } finally {
            runLifecycle.clearActiveSessionRun(session.sessionId);
            try {
              await recoveryStore.upsert({
                sessionKey: payload.sessionKey,
                sessionId: session.sessionId,
                lastRunId: accepted.runId,
              });
            } catch (error) {
              const summary = toErrorSummary(error);
              logControlPlane({
                level: "warn",
                event: "session_recovery.persist_failed",
                runId: accepted.runId,
                sessionKey: payload.sessionKey,
                toolCallId: null,
                errorCode: summary.errorCode,
                message: summary.errorMessage,
              });
            }
          }
        })();
      } catch (error) {
        const summary = toErrorSummary(error);
        logControlPlane({
          level: "warn",
          event: "run.rejected",
          runId: null,
          sessionKey: null,
          toolCallId: null,
          errorCode: summary.errorCode,
          message: summary.errorMessage,
        });
        writeJson(res, toHttpStatusCode(summary), {
          code: summary.errorCode,
          message: summary.errorMessage,
        });
      }
      return;
    }

    if (method === "GET" && (url === "/" || url === "/index.html")) {
      res.statusCode = 200;
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(renderMinimalUiPage());
      return;
    }

    const runAuditMatch = url.match(/^\/api\/chat\/runs\/([^/]+)\/audit$/);
    if (method === "GET" && runAuditMatch && runAuditMatch[1]) {
      const runId = decodeURIComponent(runAuditMatch[1]);
      const audit = await readRunAudit(runId, agentAuditLog);
      writeJson(res, 200, audit);
      return;
    }

    writeJson(res, 404, { code: "NOT_FOUND", message: `${method} ${url}` });
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
    await supervisor.stop();
    await agentAuditLog.flush();
    await sandboxRuntime.dispose();
    logControlPlane({
      event: "server.shutdown.done",
      runId: null,
      sessionKey: null,
      toolCallId: null,
    });
  };

  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
