import { createApiServer } from "./api-server.js";
import * as ChatHandler from "./chat-handler.js";
import * as StreamEventBridge from "./stream-event-bridge.js";
import { configureAgentAuditLogger } from "./agent-audit.js";
import { configureSandbox } from "./agent-session-factory.js";
import { createAgentRunAdapter } from "./main.adapter.js";
import { createMarkdownSummaryBatchService } from "./markdown-summary-batch.js";
import { resolveSessionRecordPath, resolveSummaryBatchWatermarkPath } from "./session-paths.js";
import { handleTerminalRecord } from "./terminal-record-handler.js";
import type { NormalizedEvent } from "../core/events.js";
import {
  enqueueSystemEvent,
  runAgent,
  startHeartbeat,
  runOnce,
  onHeartbeatEvent,
  getLastHeartbeatEvent,
  type HeartbeatConfig,
} from "./index.js";
import { createChannelManager } from "../proactive/channel-manager.js";
import { createBatchClassifier } from "../proactive/batch-classifier.js";
import { createChannelNotificationPipeline } from "../proactive/channel-notification-pipeline.js";
import {
  createDualWriteCoordinator,
  type DualWriteRecord,
} from "../proactive/dual-write-coordinator.js";
import { createChannelPluginRegistry } from "../proactive/plugin-registry.js";
import { createOpenAiSecondaryClassifier } from "../proactive/route-llm-classifier.js";
import { createSlackChannelPlugin } from "../proactive/slack-channel-plugin.js";
import { createTriggerFilter, type SecondaryClassifier } from "../proactive/trigger-filter.js";
import { createGlobalConcurrencyQueue } from "../proactive/global-concurrency-queue.js";
import { createPendingFlusher } from "../proactive/pending-flusher.js";
import { createWatermarkStore } from "../proactive/watermark-store.js";
import { routeEventKindFromEvent } from "../proactive/route-decision.js";
import { createProactiveMetrics } from "../proactive/metrics.js";
import { listJsonlFiles, recoverJsonlFiles } from "../io/jsonl-recovery.js";
import { loadAssistantGatewayRuntimeConfig } from "../runtime/runtime-config-loader.js";
import { loadEnvFileIfPresent } from "../runtime/env-file-loader.js";
import { installConsoleFileLogger } from "../runtime/process-log-file.js";
import {
  checkDockerAvailability,
  destroySandboxContainer,
  ensureDockerImage,
  ensureSandboxContainer,
} from "../sandbox/docker.js";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

loadEnvFileIfPresent();

const runtimeConfig = loadAssistantGatewayRuntimeConfig();
const PORT = runtimeConfig.app.assistant.port;
const HOST = runtimeConfig.app.assistant.host;
const DATA_DIR = runtimeConfig.app.assistant.dataDir;
const WORKSPACE_DIR = runtimeConfig.app.assistant.workspaceDir;
const TIMEZONE = runtimeConfig.app.assistant.timezone;
const MODEL = runtimeConfig.app.assistant.model;
const TIMELINE_PATH = runtimeConfig.app.assistant.timelinePath;
const ASSISTANT_LOG_PATH = runtimeConfig.app.assistant.logPath;
const AGENT_AUDIT = runtimeConfig.app.agentAudit;
const SESSION_STATE_DIR = runtimeConfig.app.sessionStorage.stateDir;
const SESSION_AGENT_ID = runtimeConfig.app.sessionStorage.agentId;
const SESSION_TRANSCRIPTS_DIR = runtimeConfig.app.sessionStorage.transcriptsDir;
const SESSION_ENTRIES_PATH = runtimeConfig.app.sessionStorage.sessionEntriesPath;
const MARKDOWN_SUMMARY_BATCH = runtimeConfig.app.markdownSummaryBatch;
const SANDBOX_CONFIG = runtimeConfig.app.sandbox;
const IDEMPOTENCY_STORE_PATH = runtimeConfig.app.idempotency.storePath;
const IDEMPOTENCY_MAX_ENTRIES = runtimeConfig.app.idempotency.maxEntries;
const IDEMPOTENCY_STORE_FAILURE_MODE = runtimeConfig.app.idempotency.failureMode;
const SSE_REPLAY_BUFFER_SIZE = runtimeConfig.app.sse.replayBufferSize;
const SSE_REPLAY_MAX_AGE_MS = runtimeConfig.app.sse.replayMaxAgeMs;
const SLACK_RETRY_BASE_MS = runtimeConfig.app.slack.retryBaseMs;
const SLACK_RETRY_MAX_MS = runtimeConfig.app.slack.retryMaxMs;
const SLACK_DEFAULT_ACCOUNT_ID = runtimeConfig.app.slack.defaultAccountId;
const FLUSHER_INTERVAL_MS = parsePositiveInt(process.env.ADJUTANT_FLUSHER_INTERVAL_MS, 300_000);
const FLUSHER_STALE_MS = parsePositiveInt(process.env.ADJUTANT_FLUSHER_STALE_MS, 900_000);

let consoleLogHandle: { flush: () => Promise<void> } | null = null;
try {
  consoleLogHandle = await installConsoleFileLogger(ASSISTANT_LOG_PATH);
  console.log(`[Assistant] Process log file -> ${ASSISTANT_LOG_PATH}`);
} catch (error) {
  console.warn("[Assistant] 動作ログファイルの初期化に失敗しました:", toReason(error));
}

configureAgentAuditLogger({
  enabled: AGENT_AUDIT.enabled,
  path: AGENT_AUDIT.path,
  maxFieldChars: AGENT_AUDIT.maxFieldChars,
  onWarn: (message, meta) => {
    console.warn("[AssistantGateway][AgentAudit]", message, meta ?? {});
  },
});

function toReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(1, Math.floor(parsed));
}

function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(0, Math.floor(parsed));
}

let activeSandboxContainer: { containerName: string; ownerNonce: string } | null = null;

if (SANDBOX_CONFIG.mode === "off") {
  configureSandbox(null);
} else {
  const availability = await checkDockerAvailability();
  if (!availability.available) {
    throw new Error(
      `サンドボックスモードの起動には Docker デーモンが必要です。Docker Desktop を起動して再実行してください。${availability.reason ? ` 理由: ${availability.reason}` : ""} サンドボックスを無効化する場合は ADJUTANT_SANDBOX_MODE=off を設定してください。`
    );
  }
  await ensureDockerImage(SANDBOX_CONFIG.docker.image, {
    autoBuild: SANDBOX_CONFIG.docker.autoBuildImage,
    buildContextDir: process.cwd(),
  });
  const ownerNonce = randomUUID().slice(0, 6);
  const containerName = await ensureSandboxContainer({
    cfg: SANDBOX_CONFIG.docker,
    hostWorkspaceDir: WORKSPACE_DIR,
    ownerNonce,
  });
  configureSandbox({
    containerName,
    workdir: SANDBOX_CONFIG.docker.workdir,
    hostWorkspaceDir: WORKSPACE_DIR,
    mode: SANDBOX_CONFIG.mode,
    envAllowlist: SANDBOX_CONFIG.docker.envAllowlist,
  });
  activeSandboxContainer = { containerName, ownerNonce };
  console.log(`[Assistant] Sandbox enabled mode=${SANDBOX_CONFIG.mode} container=${containerName}`);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function buildChunkEvent(events: NormalizedEvent[], prompt: string): NormalizedEvent | null {
  const latest = events[events.length - 1];
  if (!latest) {
    return null;
  }
  const first = events[0] ?? latest;
  if (latest.source !== "slack") {
    return {
      ...latest,
      uid: `chunk:${first.uid}:${latest.uid}:${events.length}`,
      kind: "post",
    };
  }
  const detail = asRecord(latest.detail);
  const slack = asRecord(detail?.slack);
  const channelId =
    typeof slack?.channel_id === "string" && slack.channel_id.trim().length > 0
      ? slack.channel_id
      : "chunk";
  const messageTs = typeof slack?.message_ts === "string" ? slack.message_ts : undefined;
  const threadTs = typeof slack?.thread_ts === "string" ? slack.thread_ts : undefined;
  return {
    ...latest,
    uid: `chunk:${first.uid}:${latest.uid}:${events.length}`,
    kind: "post",
    detail: {
      slack: {
        channel_id: channelId,
        message_ts: messageTs,
        thread_ts: threadTs,
        text: prompt,
      },
    },
  };
}

const appendTails = new Map<string, Promise<void>>();

async function withAppendLock<T>(path: string, task: () => Promise<T>): Promise<T> {
  const previousTail = appendTails.get(path) ?? Promise.resolve();
  let releaseTail!: () => void;
  const hold = new Promise<void>((resolve) => {
    releaseTail = resolve;
  });
  const nextTail = previousTail.then(() => hold);
  appendTails.set(path, nextTail);
  await previousTail;
  try {
    return await task();
  } finally {
    releaseTail();
    if (appendTails.get(path) === nextTail) {
      appendTails.delete(path);
    }
  }
}

async function appendJsonl(path: string, record: DualWriteRecord): Promise<{ offset: number }> {
  return await withAppendLock(path, async () => {
    await mkdir(dirname(path), { recursive: true });
    let offset = 0;
    try {
      const info = await stat(path);
      offset = Math.max(0, Math.floor(info.size));
    } catch (error) {
      const errno = error as NodeJS.ErrnoException;
      if (errno.code !== "ENOENT") {
        throw error;
      }
    }

    await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
    return { offset };
  });
}

const jsonlRecoveryTargets = new Set<string>([TIMELINE_PATH, IDEMPOTENCY_STORE_PATH]);
for (const filePath of await listJsonlFiles(SESSION_TRANSCRIPTS_DIR)) {
  jsonlRecoveryTargets.add(filePath);
}
for (const filePath of await listJsonlFiles(DATA_DIR)) {
  jsonlRecoveryTargets.add(filePath);
}
const jsonlRecoveryResults = await recoverJsonlFiles(jsonlRecoveryTargets);
const repairedJsonl = jsonlRecoveryResults.filter((result) => result.repaired);
if (repairedJsonl.length > 0) {
  console.warn(
    "[AssistantGateway] JSONL recovery repaired files",
    repairedJsonl.map((item) => ({
      filePath: item.filePath,
      reason: item.reason,
      truncatedBytes: item.truncatedBytes,
    }))
  );
}

StreamEventBridge.configureReplay({
  maxEventsPerRun: Number.isFinite(SSE_REPLAY_BUFFER_SIZE)
    ? Math.max(1, Math.floor(SSE_REPLAY_BUFFER_SIZE))
    : 512,
  maxAgeMs: Number.isFinite(SSE_REPLAY_MAX_AGE_MS)
    ? Math.max(1000, Math.floor(SSE_REPLAY_MAX_AGE_MS))
    : 300_000,
});

const dualWriteCoordinator = createDualWriteCoordinator({
  appendTimelineRecord: async (record) => {
    return await appendJsonl(TIMELINE_PATH, record);
  },
  appendSessionRecord: async (record) => {
    const sessionKey =
      typeof record.sessionKey === "string" && record.sessionKey.trim().length > 0
        ? record.sessionKey.trim()
        : null;
    if (!sessionKey) {
      throw new Error("dual write requires record.sessionKey");
    }
    await appendJsonl(
      resolveSessionRecordPath({
        stateDir: SESSION_STATE_DIR,
        sessionKey,
        agentId: SESSION_AGENT_ID,
        sessionTranscriptsDir: SESSION_TRANSCRIPTS_DIR,
      }),
      record
    );
  },
  onWarn: (message, meta) => {
    console.warn("[AssistantGateway][DualWrite]", message, meta ?? {});
  },
});

const proactiveMetrics = createProactiveMetrics({
  onRecord: (record) => {
    console.info("[AssistantGateway][Metrics]", record);
  },
});
const globalConcurrencyQueue = createGlobalConcurrencyQueue({
  maxConcurrent: parsePositiveInt(process.env.ADJUTANT_GLOBAL_MAX_CONCURRENT, 3),
  dmBurstSlot: parseNonNegativeInt(process.env.ADJUTANT_GLOBAL_DM_BURST_SLOT, 1),
  maxRunningDM: parsePositiveInt(process.env.ADJUTANT_GLOBAL_MAX_RUNNING_DM, 3),
  starvationMs: parsePositiveInt(process.env.ADJUTANT_GLOBAL_STARVATION_MS, 120_000),
  metrics: proactiveMetrics,
});
const watermarkStore = createWatermarkStore({
  path: join(SESSION_STATE_DIR, "watermarks.json"),
  timelinePath: TIMELINE_PATH,
  onWarn: (message, meta) => {
    console.warn("[AssistantGateway][WatermarkStore]", message, meta ?? {});
  },
});

const agentRunFn = createAgentRunAdapter(
  {
    workspaceDir: WORKSPACE_DIR,
    timezone: TIMEZONE,
    model: MODEL,
    sessionEntriesPath: SESSION_ENTRIES_PATH,
    onTerminalRecord: async (terminal) => {
      await handleTerminalRecord(
        {
          dualWriteCoordinator,
          watermarkStore,
          onWarn: (message, meta) => {
            if (message === "terminal-record-queued") {
              console.warn("[AssistantGateway][DualWrite] terminal record queued", meta ?? {});
              return;
            }
            if (message === "terminal-watermark-apply-failed") {
              console.warn("[AssistantGateway][WatermarkStore] terminal apply failed", meta ?? {});
              return;
            }
            if (message === "terminal-timeline-offset-missing") {
              console.warn(
                "[AssistantGateway][WatermarkStore] timeline offset missing",
                meta ?? {}
              );
              return;
            }
            console.warn("[AssistantGateway][TerminalRecord]", message, meta ?? {});
          },
        },
        terminal
      );
    },
  },
  runAgent
);

ChatHandler.configure({
  runAgent: agentRunFn,
  globalConcurrencyQueue,
  dataDir: DATA_DIR,
  workspaceDir: WORKSPACE_DIR,
  timezone: TIMEZONE,
  idempotencyTtlSec: 300,
  idempotencyStorePath: IDEMPOTENCY_STORE_PATH,
  idempotencyMaxEntries: Number.isFinite(IDEMPOTENCY_MAX_ENTRIES)
    ? Math.max(100, Math.floor(IDEMPOTENCY_MAX_ENTRIES))
    : 5000,
  idempotencyStoreFailureMode: IDEMPOTENCY_STORE_FAILURE_MODE,
});

const routeLlmConfig = {
  enabled: runtimeConfig.app.routeLlm.enabled,
  provider: runtimeConfig.app.routeLlm.provider,
  model: runtimeConfig.app.routeLlm.model,
  routeLlmTimeoutMs: runtimeConfig.app.routeLlm.timeoutMs,
  maxConcurrentRouteLlm: runtimeConfig.app.routeLlm.maxConcurrent,
};
let secondaryClassifier: SecondaryClassifier | undefined;

if (routeLlmConfig.enabled) {
  const apiKey = runtimeConfig.openAiApiKey;
  if (!apiKey) {
    console.warn(
      "[AssistantGateway][RouteLLM] disabled: OPENAI_API_KEY is required when ADJUTANT_ROUTE_LLM_ENABLED=1"
    );
  } else {
    secondaryClassifier = createOpenAiSecondaryClassifier({
      apiKey,
      model: routeLlmConfig.model,
      maxConcurrent: routeLlmConfig.maxConcurrentRouteLlm,
      onAudit: (log) => {
        const { event, ...meta } = log;
        if (event === "route-llm-error") {
          console.warn("[AssistantGateway][RouteLLM][Error]", meta);
          return;
        }
        console.info("[AssistantGateway][RouteLLM]", meta);
      },
    });
    console.log(
      `[Assistant] Route LLM enabled provider=${routeLlmConfig.provider} model=${routeLlmConfig.model} timeoutMs=${routeLlmConfig.routeLlmTimeoutMs} maxConcurrent=${routeLlmConfig.maxConcurrentRouteLlm}`
    );
  }
}

const triggerFilter = createTriggerFilter({
  secondaryClassifier,
  secondaryTimeoutMs: routeLlmConfig.routeLlmTimeoutMs,
  warn: (message, meta) => {
    console.warn("[AssistantGateway][RouteFilter]", message, meta ?? {});
  },
});

const batchClassifier = createBatchClassifier({
  timeoutMs: routeLlmConfig.routeLlmTimeoutMs,
  metrics: proactiveMetrics,
  classifyChunk: async ({ events, prompt }) => {
    const chunkEvent = buildChunkEvent(events, prompt);
    if (!chunkEvent || !secondaryClassifier) {
      return {
        action: "respond",
        confidence: 0.75,
        reason: "secondary-classifier-unavailable",
      };
    }

    const outcome = await secondaryClassifier({
      event: chunkEvent,
      selfState: "non-self",
      eventKind: routeEventKindFromEvent(chunkEvent),
      primaryOutcome: "run",
    });
    if (outcome === "pending") {
      return {
        action: "note",
        confidence: 0.8,
        reason: "secondary-pending",
      };
    }
    return {
      action: "respond",
      confidence: 0.8,
      reason: "secondary-run",
    };
  },
  onWarn: (message, meta) => {
    console.warn("[AssistantGateway][BatchClassifier]", message, meta ?? {});
  },
});

const pipeline = createChannelNotificationPipeline({
  triggerFilter,
  batchClassifier,
  globalConcurrencyQueue,
  metrics: proactiveMetrics,
  acceptMessage: (request) => ChatHandler.acceptMessage(request),
  enqueueSystemEvent: (text, opts) => enqueueSystemEvent(text, opts),
  dualWriteCoordinator,
  runTarget: "main",
  mainSessionKey: "main",
  onWarn: (message, meta) => {
    console.warn("[AssistantGateway][Pipeline]", message, meta ?? {});
  },
});

const pluginRegistry = createChannelPluginRegistry();
pluginRegistry.register(
  createSlackChannelPlugin({
    dataDir: DATA_DIR,
    timezone: TIMEZONE,
    defaultAccountId: SLACK_DEFAULT_ACCOUNT_ID,
    domCaptureDisabled: runtimeConfig.app.slack.domCaptureDisabled,
    retryBaseMs: Number.isFinite(SLACK_RETRY_BASE_MS)
      ? Math.max(1, Math.floor(SLACK_RETRY_BASE_MS))
      : 1000,
    retryMaxMs: Number.isFinite(SLACK_RETRY_MAX_MS)
      ? Math.max(1, Math.floor(SLACK_RETRY_MAX_MS))
      : 10000,
    onWarn: (message, meta) => {
      console.warn("[AssistantGateway][SlackPlugin]", message, meta ?? {});
    },
  })
);

const channelManager = createChannelManager({
  registry: pluginRegistry,
  emit: (input) => pipeline.enqueue(input),
  onError: (message, meta) => {
    console.error("[AssistantGateway][ChannelManager]", message, meta ?? {});
  },
});

const heartbeatConfig: HeartbeatConfig = {
  dataDir: DATA_DIR,
  stateDir: SESSION_STATE_DIR,
  workspaceDir: WORKSPACE_DIR,
  userTimezone: TIMEZONE,
  defaultAccountId: SLACK_DEFAULT_ACCOUNT_ID,
  model: MODEL,
  globalConcurrencyQueue,
  intervalMs: runtimeConfig.app.heartbeat.intervalMs,
  channelsConfigPath: runtimeConfig.channelsConfigPath,
};

const heartbeatHandle = startHeartbeat(heartbeatConfig);
const pendingFlusher = createPendingFlusher({
  timelinePath: TIMELINE_PATH,
  watermarkStore,
  staleMs: FLUSHER_STALE_MS,
  metrics: proactiveMetrics,
  enqueueSession: async ({ sessionKey, reason, openPostCount }) => {
    const idempotencyKey = `flusher:${sessionKey}:${Math.floor(Date.now() / FLUSHER_INTERVAL_MS)}`;
    ChatHandler.acceptMessage({
      message: `[PendingFlusher] ${reason} openPostCount=${openPostCount}`,
      sessionKey,
      idempotencyKey,
      origin: "pipeline",
      originSessionKey: sessionKey,
      pipelineSource: "flusher",
    });
  },
  onWarn: (message, meta) => {
    console.warn("[AssistantGateway][PendingFlusher]", message, meta ?? {});
  },
});
const pendingFlusherTimer =
  FLUSHER_INTERVAL_MS > 0
    ? setInterval(() => {
        void pendingFlusher.tick().catch((error) => {
          console.warn("[AssistantGateway][PendingFlusher] tick failed", toReason(error));
        });
      }, FLUSHER_INTERVAL_MS)
    : null;

const markdownSummaryBatchService = createMarkdownSummaryBatchService({
  workspaceDir: WORKSPACE_DIR,
  timezone: TIMEZONE,
  sessionTranscriptsDir: SESSION_TRANSCRIPTS_DIR,
  watermarkPath: resolveSummaryBatchWatermarkPath({
    stateDir: SESSION_STATE_DIR,
    agentId: SESSION_AGENT_ID,
  }),
  messages: MARKDOWN_SUMMARY_BATCH.messages,
  maxSessions: MARKDOWN_SUMMARY_BATCH.maxSessions,
  onWarn: (message, meta) => {
    console.warn("[AssistantGateway][MarkdownSummaryBatch]", message, meta ?? {});
  },
});
let markdownSummaryBatchRunning = false;
const markdownSummaryBatchTimer =
  MARKDOWN_SUMMARY_BATCH.enabled && MARKDOWN_SUMMARY_BATCH.intervalMs > 0
    ? setInterval(() => {
        if (markdownSummaryBatchRunning) {
          console.warn(
            "[AssistantGateway][MarkdownSummaryBatch] skipped: previous run is still in-flight"
          );
          return;
        }
        markdownSummaryBatchRunning = true;
        void markdownSummaryBatchService
          .runOnce()
          .catch((error) => {
            console.warn("[AssistantGateway][MarkdownSummaryBatch] run failed", toReason(error));
          })
          .finally(() => {
            markdownSummaryBatchRunning = false;
          });
      }, MARKDOWN_SUMMARY_BATCH.intervalMs)
    : null;

const api = createApiServer({
  port: PORT,
  host: HOST,
  corsOrigin: runtimeConfig.corsOrigin,
  heartbeatProvider: {
    onHeartbeatEvent,
    getLastHeartbeatEvent,
    runOnce: (opts) => runOnce(heartbeatConfig, opts),
  },
});

let viteChild: ChildProcess | null = null;

const dualWriteRetryIntervalMs = runtimeConfig.dualWriteRetryIntervalMs;

const dualWriteRetryTimer =
  dualWriteRetryIntervalMs > 0
    ? setInterval(() => {
        void dualWriteCoordinator
          .retryPending()
          .then((result) => {
            if (result.pendingTimeline > 0 || result.pendingSessionBackfill > 0) {
              console.warn("[AssistantGateway][DualWrite] pending", result);
            }
          })
          .catch((error) => {
            console.warn("[AssistantGateway][DualWrite] retryPending failed", toReason(error));
          });
      }, dualWriteRetryIntervalMs)
    : null;

let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`\n[Assistant] Shutting down... (${signal})`);
  heartbeatHandle.stop();
  if (pendingFlusherTimer) {
    clearInterval(pendingFlusherTimer);
  }
  if (dualWriteRetryTimer) {
    clearInterval(dualWriteRetryTimer);
  }
  if (markdownSummaryBatchTimer) {
    clearInterval(markdownSummaryBatchTimer);
  }
  const stopTargets = pluginRegistry.list().map((plugin) => channelManager.stopChannel(plugin.id));
  await Promise.allSettled([api.stop(), ...stopTargets]);
  if (activeSandboxContainer) {
    try {
      const result = await destroySandboxContainer({
        containerName: activeSandboxContainer.containerName,
        ownerNonce: activeSandboxContainer.ownerNonce,
      });
      if (!result.removed) {
        console.warn("[Assistant][Sandbox] container cleanup skipped", {
          containerName: activeSandboxContainer.containerName,
          reason: result.reason,
        });
      }
    } catch (error) {
      console.warn("[Assistant][Sandbox] container cleanup failed", toReason(error));
    } finally {
      activeSandboxContainer = null;
      configureSandbox(null);
    }
  }
  viteChild?.kill();
  if (consoleLogHandle) {
    await consoleLogHandle.flush();
  }
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

await api.start();
console.log(`[Assistant] API server ready at http://${HOST}:${PORT}`);
await channelManager.startChannels();
console.log("[Assistant] Gateway channels started");

// Start Vite dev server for UI
const VITE_PORT = runtimeConfig.vitePort;
const viteBin = resolve(process.cwd(), "node_modules/.bin/vite");
viteChild = spawn(viteBin, ["--port", String(VITE_PORT)], {
  stdio: "inherit",
  cwd: process.cwd(),
});
viteChild.on("error", (err) => {
  console.error("[Assistant] Failed to start Vite dev server:", err.message);
});
console.log(`[Assistant] Vite dev server starting on port ${VITE_PORT}`);
