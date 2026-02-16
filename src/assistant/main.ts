import { createApiServer } from "./api-server.js";
import * as ChatHandler from "./chat-handler.js";
import { createAgentRunAdapter } from "./main.adapter.js";
import {
  runAgent,
  startHeartbeat,
  runOnce,
  onHeartbeatEvent,
  getLastHeartbeatEvent,
  type HeartbeatConfig,
} from "./index.js";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";

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

const heartbeatConfig: HeartbeatConfig = {
  dataDir: DATA_DIR,
  workspaceDir: WORKSPACE_DIR,
  userTimezone: TIMEZONE,
  model: MODEL,
  intervalMs: Number(process.env.ADJUTANT_HEARTBEAT_INTERVAL_MS ?? "1800000"),
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

function shutdown() {
  console.log("\n[Assistant] Shutting down...");
  heartbeatHandle.stop();
  api.stop().catch(() => {});
  viteChild?.kill();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await api.start();
console.log(`[Assistant] API server ready at http://${HOST}:${PORT}`);

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
