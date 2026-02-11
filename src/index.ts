import { resolveDataDir, resolveEndpoint } from "./runtime/config.js";
import { connectToSlackPage } from "./runtime/slackConnection.js";
import { JsonlWriter } from "./io/jsonlWriter.js";
import { SlackAdapter } from "./slack/adapter.js";
import { SlackIngestor } from "./pipeline/slackIngestor.js";
import { DebugUiServer } from "./debug/debugUi.js";
import type { SlackCdpClient } from "./runtime/slackConnection.js";

type ActiveSession = {
  client: SlackCdpClient;
  ingestor: SlackIngestor;
};

const BASE_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 10000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const isEnabled = (value: string | undefined) =>
  value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "yes";

const waitForDisconnect = (client: SlackCdpClient) =>
  new Promise<void>((resolve, reject) => {
    const handleDisconnect = () => {
      cleanup();
      resolve();
    };
    const handleError = (...args: unknown[]) => {
      cleanup();
      const [err] = args;
      reject(err);
    };
    const cleanup = () => {
      client.removeListener("disconnect", handleDisconnect);
      client.removeListener("error", handleError);
      if (typeof client.off === "function") {
        client.off("disconnect", handleDisconnect);
        client.off("error", handleError);
      }
    };
    client.on("disconnect", handleDisconnect);
    client.on("error", handleError);
  });

async function main() {
  const { host, port } = resolveEndpoint();
  console.log(`[Adjutant] CDP endpoint -> ${host}:${port}`);

  const dataDir = resolveDataDir();
  console.log(`[Adjutant] dataDir -> ${dataDir}`);

  const timezone = process.env.ADJUTANT_TZ || "Asia/Tokyo";
  console.log(`[Adjutant] timezone -> ${timezone}`);

  const writer = new JsonlWriter({ dataDir });
  const now = () => new Date();
  const debugUiEnabled = isEnabled(process.env.ADJUTANT_DEBUG_UI);
  const debugUiPort = Number(process.env.ADJUTANT_DEBUG_UI_PORT || "8787");
  const debugUi = debugUiEnabled ? new DebugUiServer({ port: debugUiPort }) : null;

  if (debugUi) {
    await debugUi.start();
    console.log(`[Adjutant] debug UI -> http://127.0.0.1:${debugUiPort}`);
    debugUi.record({
      source: "system",
      kind: "lifecycle",
      at: new Date().toISOString(),
      payload: { event: "debug_ui_started", port: debugUiPort },
    });
  }

  let activeSession: ActiveSession | null = null;
  let shuttingDown = false;
  let continueRunning = true;
  let retryCount = 0;

  const cleanupActiveSession = async () => {
    const session = activeSession;
    if (!session) return;
    activeSession = null;
    try {
      await session.ingestor.stop();
    } catch (err) {
      console.error("[Adjutant] failed to stop ingestor:", err);
    }
    if (session.client && typeof session.client.close === "function") {
      try {
        await session.client.close();
      } catch (err) {
        console.error("[Adjutant] failed to close CDP client:", err);
      }
    }
  };

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    continueRunning = false;
    console.log(`[Adjutant] received ${signal}, shutting down...`);
    if (debugUi) {
      debugUi.record({
        source: "system",
        kind: "lifecycle",
        at: new Date().toISOString(),
        payload: { event: "shutdown", signal },
      });
    }
    await cleanupActiveSession();
    if (debugUi) {
      await debugUi.stop();
    }
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  const runSession = async (): Promise<"disconnect"> => {
    console.log("[Adjutant] establishing new CDP session...");
    if (debugUi) {
      debugUi.record({
        source: "system",
        kind: "lifecycle",
        at: new Date().toISOString(),
        payload: { event: "session_connecting", host, port },
      });
    }
    const { client, slackUrl } = await connectToSlackPage(host, port);
    console.log(`[Adjutant] attached to: ${slackUrl}`);
    if (debugUi) {
      debugUi.record({
        source: "system",
        kind: "lifecycle",
        at: new Date().toISOString(),
        payload: { event: "session_attached", slackUrl },
      });
    }

    const adapter = new SlackAdapter({
      client,
      now,
      timezone,
      onDebugEvent: debugUi ? (event) => debugUi.record(event) : undefined,
    });
    const ingestor = new SlackIngestor({ adapter, writer });
    activeSession = { client, ingestor };

    try {
      await ingestor.start();
      console.log("[Adjutant] Slack ingestion started");
      if (debugUi) {
        debugUi.record({
          source: "system",
          kind: "lifecycle",
          at: new Date().toISOString(),
          payload: { event: "ingestion_started" },
        });
      }
      await waitForDisconnect(client);
      return "disconnect";
    } finally {
      await cleanupActiveSession();
    }
  };

  while (continueRunning) {
    try {
      const result = await runSession();
      if (!continueRunning) break;
      if (result === "disconnect") {
        console.warn("[Adjutant] CDP connection closed. Attempting to reconnect...");
        if (debugUi) {
          debugUi.record({
            source: "system",
            kind: "lifecycle",
            at: new Date().toISOString(),
            payload: { event: "session_disconnected" },
          });
        }
      }
      retryCount = 0;
    } catch (err) {
      if (!continueRunning) break;
      retryCount += 1;
      console.error("[Adjutant] session ended with error:", err);
      if (debugUi) {
        debugUi.record({
          source: "system",
          kind: "lifecycle",
          at: new Date().toISOString(),
          payload: { event: "session_error", retryCount, error: String(err) },
        });
      }
    }

    if (!continueRunning) break;

    const delayMs = Math.min(BASE_RETRY_DELAY_MS * Math.max(1, retryCount), MAX_RETRY_DELAY_MS);
    console.log(`[Adjutant] Retrying connection in ${delayMs}ms...`);
    await sleep(delayMs);
  }
}

main().catch((err) => {
  console.error("[Adjutant] fatal:", err);
  process.exit(1);
});
