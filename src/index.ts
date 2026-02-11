import { resolveDataDir, resolveEndpoint } from "./runtime/config.js";
import { connectToSlackPage } from "./runtime/slackConnection.js";
import { JsonlWriter } from "./io/jsonlWriter.js";
import { SlackAdapter } from "./slack/adapter.js";
import { SlackIngestor } from "./pipeline/slackIngestor.js";
import type { SlackCdpClient } from "./runtime/slackConnection.js";

type ActiveSession = {
  client: SlackCdpClient;
  ingestor: SlackIngestor;
};

const BASE_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 10000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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
  console.log(`[ReacLog] CDP endpoint -> ${host}:${port}`);

  const dataDir = resolveDataDir();
  console.log(`[ReacLog] dataDir -> ${dataDir}`);

  const timezone = process.env.REACLOG_TZ || "Asia/Tokyo";
  console.log(`[ReacLog] timezone -> ${timezone}`);

  const writer = new JsonlWriter({ dataDir });
  const now = () => new Date();

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
      console.error("[ReacLog] failed to stop ingestor:", err);
    }
    if (session.client && typeof session.client.close === "function") {
      try {
        await session.client.close();
      } catch (err) {
        console.error("[ReacLog] failed to close CDP client:", err);
      }
    }
  };

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    continueRunning = false;
    console.log(`[ReacLog] received ${signal}, shutting down...`);
    await cleanupActiveSession();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  const runSession = async (): Promise<"disconnect"> => {
    console.log("[ReacLog] establishing new CDP session...");
    const { client, slackUrl } = await connectToSlackPage(host, port);
    console.log(`[ReacLog] attached to: ${slackUrl}`);

    const adapter = new SlackAdapter({ client, now, timezone });
    const ingestor = new SlackIngestor({ adapter, writer });
    activeSession = { client, ingestor };

    try {
      await ingestor.start();
      console.log("[ReacLog] Slack ingestion started");
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
        console.warn("[ReacLog] CDP connection closed. Attempting to reconnect...");
      }
      retryCount = 0;
    } catch (err) {
      if (!continueRunning) break;
      retryCount += 1;
      console.error("[ReacLog] session ended with error:", err);
    }

    if (!continueRunning) break;

    const delayMs = Math.min(BASE_RETRY_DELAY_MS * Math.max(1, retryCount), MAX_RETRY_DELAY_MS);
    console.log(`[ReacLog] Retrying connection in ${delayMs}ms...`);
    await sleep(delayMs);
  }
}

main().catch((err) => {
  console.error("[ReacLog] fatal:", err);
  process.exit(1);
});
