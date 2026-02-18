import { createApiServer } from "./api-server.js";
import * as ChatHandler from "./chat-handler.js";
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
import { createChannelManager } from "../openclaw/channel-manager.js";
import { createChannelNotificationPipeline } from "../openclaw/channel-notification-pipeline.js";
import {
  createDualWriteCoordinator,
  type DualWriteRecord,
} from "../openclaw/dual-write-coordinator.js";
import { createChannelPluginRegistry } from "../openclaw/plugin-registry.js";
import { createSlackChannelPlugin } from "../openclaw/slack-channel-plugin.js";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

// Enable prompt cache by default (Anthropic 5min→1h, OpenAI 24h, Bedrock cache points)
if (!process.env.PI_CACHE_RETENTION) {
  process.env.PI_CACHE_RETENTION = "long";
}

const PORT = Number(process.env.ADJUTANT_API_PORT ?? "3100");
const HOST = process.env.ADJUTANT_API_HOST ?? "127.0.0.1";
const DATA_DIR = process.env.ADJUTANT_DATA_DIR ?? "data";
const WORKSPACE_DIR = process.env.ADJUTANT_WORKSPACE_DIR ?? DATA_DIR;
const TIMEZONE = process.env.ADJUTANT_TZ ?? "Asia/Tokyo";
const MODEL = process.env.ADJUTANT_MODEL || undefined;
const TIMELINE_PATH =
  process.env.ADJUTANT_TIMELINE_PATH?.trim() || join(WORKSPACE_DIR, "memory", "timeline.jsonl");

const DEFAULT_DUAL_WRITE_RETRY_INTERVAL_MS = 5000;

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

ChatHandler.configure({
  runAgent: agentRunFn,
  dataDir: DATA_DIR,
  workspaceDir: WORKSPACE_DIR,
  timezone: TIMEZONE,
  idempotencyTtlSec: 300,
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

const pipeline = createChannelNotificationPipeline({
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
  intervalMs: Number(process.env.ADJUTANT_HEARTBEAT_INTERVAL_MS ?? "1800000"),
  heartbeatStaleMs: Number(process.env.ADJUTANT_HEARTBEAT_STALE_MS ?? "900000"),
  timelinePath: TIMELINE_PATH,
  pendingSessionBackfillProvider: () => dualWriteCoordinator.listPendingSessionBackfillUids(),
};

const heartbeatHandle = startHeartbeat(heartbeatConfig);

const api = createApiServer({
  port: PORT,
  host: HOST,
  heartbeatProvider: {
    onHeartbeatEvent,
    getLastHeartbeatEvent,
    runOnce: (opts) => runOnce(heartbeatConfig, opts),
  },
});

let viteChild: ChildProcess | null = null;

const dualWriteRetryIntervalMsRaw = Number(
  process.env.ADJUTANT_DUAL_WRITE_RETRY_INTERVAL_MS ?? DEFAULT_DUAL_WRITE_RETRY_INTERVAL_MS
);
const dualWriteRetryIntervalMs =
  Number.isFinite(dualWriteRetryIntervalMsRaw) && dualWriteRetryIntervalMsRaw > 0
    ? Math.floor(dualWriteRetryIntervalMsRaw)
    : 0;

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
const VITE_PORT = Number(process.env.ADJUTANT_VITE_PORT ?? "5173");
const viteBin = resolve(process.cwd(), "node_modules/.bin/vite");
viteChild = spawn(viteBin, ["--port", String(VITE_PORT)], {
  stdio: "inherit",
  cwd: process.cwd(),
});
viteChild.on("error", (err) => {
  console.error("[Assistant] Failed to start Vite dev server:", err.message);
});
console.log(`[Assistant] Vite dev server starting on port ${VITE_PORT}`);
