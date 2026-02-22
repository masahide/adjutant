import { createApiServer } from "./api-server.js";
import * as ChatHandler from "./chat-handler.js";
import * as StreamEventBridge from "./stream-event-bridge.js";
import { createAgentRunAdapter } from "./main.adapter.js";
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
import { createChannelNotificationPipeline } from "../proactive/channel-notification-pipeline.js";
import {
  createDualWriteCoordinator,
  type DualWriteRecord,
} from "../proactive/dual-write-coordinator.js";
import { createChannelPluginRegistry } from "../proactive/plugin-registry.js";
import { createOpenAiSecondaryClassifier } from "../proactive/route-llm-classifier.js";
import { createSlackChannelPlugin } from "../proactive/slack-channel-plugin.js";
import { createTriggerFilter, type SecondaryClassifier } from "../proactive/trigger-filter.js";
import { listJsonlFiles, recoverJsonlFiles } from "../io/jsonl-recovery.js";
import { loadAssistantGatewayRuntimeConfig } from "../runtime/runtime-config-loader.js";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const runtimeConfig = loadAssistantGatewayRuntimeConfig();
const PORT = runtimeConfig.app.assistant.port;
const HOST = runtimeConfig.app.assistant.host;
const DATA_DIR = runtimeConfig.app.assistant.dataDir;
const WORKSPACE_DIR = runtimeConfig.app.assistant.workspaceDir;
const TIMEZONE = runtimeConfig.app.assistant.timezone;
const MODEL = runtimeConfig.app.assistant.model;
const TIMELINE_PATH = runtimeConfig.app.assistant.timelinePath;
const IDEMPOTENCY_STORE_PATH = runtimeConfig.app.idempotency.storePath;
const IDEMPOTENCY_MAX_ENTRIES = runtimeConfig.app.idempotency.maxEntries;
const IDEMPOTENCY_STORE_FAILURE_MODE = runtimeConfig.app.idempotency.failureMode;
const SSE_REPLAY_BUFFER_SIZE = runtimeConfig.app.sse.replayBufferSize;
const SSE_REPLAY_MAX_AGE_MS = runtimeConfig.app.sse.replayMaxAgeMs;
const SLACK_RETRY_BASE_MS = runtimeConfig.app.slack.retryBaseMs;
const SLACK_RETRY_MAX_MS = runtimeConfig.app.slack.retryMaxMs;
const SLACK_DEFAULT_ACCOUNT_ID = runtimeConfig.app.slack.defaultAccountId;

function toReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function appendJsonl(path: string, record: DualWriteRecord): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
}

function resolveSessionRecordPath(workspaceDir: string, sessionKey: string): string {
  const normalized = sessionKey.trim().replace(/[^A-Za-z0-9._-]+/g, "_");
  const fileName = normalized || "unknown";
  return join(workspaceDir, "memory", "sessions", `${fileName}.jsonl`);
}

const agentRunFn = createAgentRunAdapter(
  { workspaceDir: WORKSPACE_DIR, timezone: TIMEZONE, model: MODEL },
  runAgent
);

const jsonlRecoveryTargets = new Set<string>([TIMELINE_PATH, IDEMPOTENCY_STORE_PATH]);
for (const filePath of await listJsonlFiles(join(WORKSPACE_DIR, "memory", "sessions"))) {
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

ChatHandler.configure({
  runAgent: agentRunFn,
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

const dualWriteCoordinator = createDualWriteCoordinator({
  appendTimelineRecord: async (record) => {
    await appendJsonl(TIMELINE_PATH, record);
  },
  appendSessionRecord: async (record) => {
    const sessionKey =
      typeof record.sessionKey === "string" && record.sessionKey.trim().length > 0
        ? record.sessionKey.trim()
        : null;
    if (!sessionKey) {
      throw new Error("dual write requires record.sessionKey");
    }
    await appendJsonl(resolveSessionRecordPath(WORKSPACE_DIR, sessionKey), record);
  },
  onWarn: (message, meta) => {
    console.warn("[AssistantGateway][DualWrite]", message, meta ?? {});
  },
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

const pipeline = createChannelNotificationPipeline({
  triggerFilter,
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
  workspaceDir: WORKSPACE_DIR,
  userTimezone: TIMEZONE,
  model: MODEL,
  intervalMs: runtimeConfig.app.heartbeat.intervalMs,
  heartbeatStaleMs: runtimeConfig.app.heartbeat.staleMs,
  timelinePath: TIMELINE_PATH,
  channelsConfigPath: runtimeConfig.channelsConfigPath,
  pendingSessionBackfillProvider: () => dualWriteCoordinator.listPendingSessionBackfillUids(),
};

const heartbeatHandle = startHeartbeat(heartbeatConfig);

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
  if (dualWriteRetryTimer) {
    clearInterval(dualWriteRetryTimer);
  }
  const stopTargets = pluginRegistry.list().map((plugin) => channelManager.stopChannel(plugin.id));
  await Promise.allSettled([api.stop(), ...stopTargets]);
  viteChild?.kill();
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
