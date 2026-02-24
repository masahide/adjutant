import { resolveDataDir, resolveEndpoint } from "./runtime/config.js";
import { connectToSlackPage } from "./runtime/slackConnection.js";
import { loadCollectorRuntimeConfig } from "./runtime/runtime-config-loader.js";
import { JsonlWriter } from "./io/jsonlWriter.js";
import { CdpEventFileLogger } from "./io/cdpEventFileLogger.js";
import { RawFetchEventFileLogger } from "./io/rawFetchEventFileLogger.js";
import { SlackAdapter } from "./slack/adapter.js";
import { SlackIngestor } from "./pipeline/slackIngestor.js";
import { DebugUiServer } from "./debug/debugUi.js";
import type { SlackCdpClient } from "./runtime/slackConnection.js";
import { computeFullJitterDelayMs } from "./runtime/retry-policy.js";
import { listJsonlFiles, recoverJsonlFiles } from "./io/jsonl-recovery.js";
import { normalizeAccountId } from "./runtime/data-paths.js";
import path from "node:path";

type ActiveSession = {
  client: SlackCdpClient;
  ingestor: SlackIngestor;
  detachCdpEventLogger?: () => void;
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
  console.log(`[Adjutant] CDP endpoint -> ${host}:${port}`);

  const dataDir = resolveDataDir();
  console.log(`[Adjutant] dataDir -> ${dataDir}`);
  const runtimeConfig = loadCollectorRuntimeConfig({ dataDir });

  const recoverTargets = await listJsonlFiles(dataDir);
  if (recoverTargets.length > 0) {
    const recovered = await recoverJsonlFiles(recoverTargets);
    const repaired = recovered.filter((item) => item.repaired);
    if (repaired.length > 0) {
      console.warn(
        `[Adjutant] JSONL recovery repaired ${repaired.length} file(s):`,
        repaired.map((item) => ({
          filePath: item.filePath,
          reason: item.reason,
          truncatedBytes: item.truncatedBytes,
        }))
      );
    }
  }

  const timezone = runtimeConfig.timezone;
  console.log(`[Adjutant] timezone -> ${timezone}`);
  if (runtimeConfig.debugSlackGetCookiesEnabled) {
    console.log("[Adjutant] debug slack getCookies -> enabled");
  }

  const defaultAccountId = normalizeAccountId(process.env.ADJUTANT_SLACK_ACCOUNT_ID, "default");
  const writer = new JsonlWriter({ dataDir, defaultAccountId });
  const now = () => new Date();
  const debugUiEnabled = runtimeConfig.debugUiEnabled;
  const debugUiPort = runtimeConfig.debugUiPort;
  const debugUi = debugUiEnabled ? new DebugUiServer({ port: debugUiPort }) : null;
  const cdpEventLogEnabled = runtimeConfig.cdpEventLogEnabled;
  const cdpEventLogPath = runtimeConfig.cdpEventLogPath;
  const cdpEventLogMaxParamChars = runtimeConfig.cdpEventLogMaxParamChars;
  const cdpEventLogger = cdpEventLogEnabled
    ? new CdpEventFileLogger({
        filePath: cdpEventLogPath,
        maxParamChars: Number.isFinite(cdpEventLogMaxParamChars)
          ? Math.max(0, Math.floor(cdpEventLogMaxParamChars))
          : 0,
      })
    : null;
  const rawFetchLogEnabled = runtimeConfig.rawFetchLogEnabled;
  const rawFetchLogPath = runtimeConfig.rawFetchLogPath;
  const rawFetchLogMaxPayloadChars = runtimeConfig.rawFetchLogMaxPayloadChars;
  const rawFetchEventLogger = rawFetchLogEnabled
    ? new RawFetchEventFileLogger({
        filePath: rawFetchLogPath,
        maxPayloadChars: Number.isFinite(rawFetchLogMaxPayloadChars)
          ? Math.max(0, Math.floor(rawFetchLogMaxPayloadChars))
          : 0,
      })
    : null;
  const onDebugEvent =
    debugUi || rawFetchEventLogger
      ? (event: { source: string; kind: string; at: string; payload: unknown }) => {
          if (debugUi) {
            debugUi.record(event);
          }
          if (rawFetchEventLogger) {
            rawFetchEventLogger.record(event);
          }
        }
      : undefined;

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
  if (cdpEventLogger) {
    console.log(`[Adjutant] CDP raw event log -> ${cdpEventLogPath}`);
  }
  if (rawFetchEventLogger) {
    console.log(`[Adjutant] raw_fetch event log -> ${rawFetchLogPath}`);
  }

  let activeSession: ActiveSession | null = null;
  let shuttingDown = false;
  let continueRunning = true;
  let retryCount = 0;

  const cleanupActiveSession = async () => {
    const session = activeSession;
    if (!session) return;
    activeSession = null;
    if (session.detachCdpEventLogger) {
      try {
        session.detachCdpEventLogger();
      } catch (err) {
        console.error("[Adjutant] failed to detach CDP event logger:", err);
      }
    }
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
    if (cdpEventLogger) {
      try {
        await cdpEventLogger.flush();
      } catch (err) {
        console.error("[Adjutant] failed to flush CDP event log:", err);
      }
    }
    if (rawFetchEventLogger) {
      try {
        await rawFetchEventLogger.flush();
      } catch (err) {
        console.error("[Adjutant] failed to flush raw_fetch event log:", err);
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
    const detachCdpEventLogger = cdpEventLogger
      ? cdpEventLogger.attach(client, { host, port, slackUrl })
      : undefined;
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
      domCaptureDisabled: runtimeConfig.domCaptureDisabled,
      channelCachePath: path.join(dataDir, "_cache", "slack", "channel-names-by-team.json"),
      userCachePath: path.join(dataDir, "_cache", "slack", "user-names-by-team.json"),
      debugFetchHookEnabled: rawFetchEventLogger ? true : undefined,
      debugCookieStoreEnabled: runtimeConfig.debugSlackGetCookiesEnabled,
      onDebugEvent,
    });
    const ingestor = new SlackIngestor({ adapter, writer });
    activeSession = { client, ingestor, detachCdpEventLogger };

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

    const delayMs = computeFullJitterDelayMs({
      attempt: Math.max(1, retryCount),
      baseMs: BASE_RETRY_DELAY_MS,
      capMs: MAX_RETRY_DELAY_MS,
    });
    console.log(`[Adjutant] Retrying connection in ${delayMs}ms...`);
    await sleep(delayMs);
  }
}

main().catch((err) => {
  console.error("[Adjutant] fatal:", err);
  process.exit(1);
});
