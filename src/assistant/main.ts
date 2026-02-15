import { createApiServer } from "./api-server.js";
import * as ChatHandler from "./chat-handler.js";
import type { StreamEvent } from "./types.js";
import { spawn, type ChildProcess } from "node:child_process";

const PORT = Number(process.env.ADJUTANT_API_PORT ?? "3100");
const HOST = process.env.ADJUTANT_API_HOST ?? "127.0.0.1";
const DATA_DIR = process.env.ADJUTANT_DATA_DIR ?? "data";
const WORKSPACE_DIR = process.env.ADJUTANT_WORKSPACE_DIR ?? DATA_DIR;
const TIMEZONE = process.env.ADJUTANT_TZ ?? "Asia/Tokyo";

// Stub AgentRunner until s02 is implemented
const stubRunAgent: ChatHandler.AgentRunFn = async ({ runId, sessionKey, prompt, onDelta }) => {
  const reply = `[stub] Received prompt (${prompt.length} chars). Agent not yet implemented.`;
  onDelta({
    runId,
    sessionKey,
    seq: 0,
    state: "final",
    message: {
      role: "assistant",
      content: [{ type: "text", text: reply }],
      timestamp: Date.now(),
    },
  } satisfies StreamEvent);
  return { status: "completed" };
};

ChatHandler.configure({
  runAgent: stubRunAgent,
  dataDir: DATA_DIR,
  workspaceDir: WORKSPACE_DIR,
  timezone: TIMEZONE,
  transcriptLimit: 20,
  idempotencyTtlSec: 300,
});

const api = createApiServer({ port: PORT, host: HOST });
let viteChild: ChildProcess | null = null;

function shutdown() {
  console.log("\n[Assistant] Shutting down...");
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
viteChild = spawn("npx", ["vite", "--port", String(VITE_PORT)], {
  stdio: "inherit",
  cwd: process.cwd(),
});
viteChild.on("error", (err) => {
  console.error("[Assistant] Failed to start Vite dev server:", err.message);
});
console.log(`[Assistant] Vite dev server starting on port ${VITE_PORT}`);
