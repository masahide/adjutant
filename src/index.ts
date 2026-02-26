import { loadEnvFileIfPresent } from "./runtime/env-file-loader.js";
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
import { resolveSlackCacheBaseDir } from "./runtime/data-paths.js";
import {
  configureSlackAuthTokenRegistry,
  resolveSlackAuthTokensFromCache,
  syncSlackAuthTokenSnapshots,
} from "./slack/slackAuthTokenRegistry.js";
import { createSlackRpcWorkspaceRegistrarFromEnv } from "./slack/slack-rpc-workspace-registrar.js";
import { SLACK_PENDING_ACCOUNT_ID } from "./slack/slackAuthTokenStore.js";
import type { SlackAuthTokenCacheSnapshot } from "./slack/slackAuthTokenCache.js";
import {
  ensureSlackRpcGatewayReady,
  resolveSlackRpcGatewayBootstrapConfig,
  stopSlackRpcGateway,
} from "./assistant/slack-rpc-gateway-bootstrap.js";
import path from "node:path";

loadEnvFileIfPresent();

type ActiveSession = {
  client: SlackCdpClient;
  adapter: SlackAdapter;
  ingestor: SlackIngestor;
  targetId: string;
  slackUrl: string;
  detachCdpEventLogger?: () => void;
  stopTokenSync?: () => void;
};

const BASE_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 10000;
const AUTH_TOKEN_SYNC_INTERVAL_MS = 1000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const GENERIC_SLACK_SUBDOMAINS = new Set(["app", "edgeapi", "hooks"]);

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

function parseWorkspaceAliasFromUrl(url: string | undefined): string | null {
  if (!url || typeof url !== "string") {
    return null;
  }
  try {
    const parsed = new URL(url);
    const hostParts = parsed.hostname.split(".").filter((part) => part.length > 0);
    if (hostParts.length < 3 || hostParts.slice(-2).join(".") !== "slack.com") {
      return null;
    }
    const subdomain = hostParts[0]?.trim();
    if (!subdomain || GENERIC_SLACK_SUBDOMAINS.has(subdomain.toLowerCase())) {
      return null;
    }
    return subdomain;
  } catch {
    return null;
  }
}

function parseWorkspaceTeamIdFromSlackClientUrl(url: string | undefined): string | null {
  if (!url || typeof url !== "string") {
    return null;
  }
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter((segment) => segment.length > 0);
    if (segments.length < 2 || segments[0] !== "client") {
      return null;
    }
    const teamId = segments[1]?.trim();
    return teamId && teamId.length > 0 ? teamId : null;
  } catch {
    return null;
  }
}

function shouldSuppressSlackAuthWarn(
  message: string,
  meta: Record<string, unknown> | undefined
): boolean {
  if (message !== "slack-auth-token-snapshot-skipped") {
    return false;
  }
  const reason = typeof meta?.reason === "string" ? meta.reason : "";
  return reason === "incoherent_token_pair";
}

function summarizeWorkspaceSnapshot(snapshot: SlackAuthTokenCacheSnapshot): {
  workspaceKey: string;
  label: string;
  hasXoxc: boolean;
  hasXoxd: boolean;
  lastSeenAt: number;
} | null {
  const workspaceKey = snapshot.workspaceKey?.trim();
  if (!workspaceKey) {
    return null;
  }
  const hasXoxc = Boolean(snapshot.tokens.xoxc?.value);
  const hasXoxd = Boolean(snapshot.tokens.xoxd?.value);
  const lastSeenAt = Math.max(
    snapshot.tokens.xoxc?.lastSeenAt ?? 0,
    snapshot.tokens.xoxd?.lastSeenAt ?? 0
  );
  const alias =
    parseWorkspaceAliasFromUrl(snapshot.tokens.xoxc?.url) ??
    parseWorkspaceAliasFromUrl(snapshot.tokens.xoxd?.url);
  const label = `${alias ?? "subdomain unavailable"} (${workspaceKey})`;
  return {
    workspaceKey,
    label,
    hasXoxc,
    hasXoxd,
    lastSeenAt,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function extractExecutedContextId(result: unknown): number | null | undefined {
  const record = asRecord(result);
  if (!record) {
    return undefined;
  }
  const attempts = Array.isArray(record.attempts) ? record.attempts : [];
  for (const attempt of attempts) {
    const item = asRecord(attempt);
    if (!item || item.ok !== true) {
      continue;
    }
    if (typeof item.contextId === "number") {
      return item.contextId;
    }
    if (item.contextId === null) {
      return null;
    }
  }
  return undefined;
}

function withCdpExecutionMeta(input: {
  result: unknown;
  requestedTargetId?: string;
  executedTargetId: string;
  executedSlackUrl: string;
  requestedWorkspaceKey?: string;
}): Record<string, unknown> {
  const base = asRecord(input.result) ?? { result: input.result };
  return {
    ...base,
    requestedTargetId: input.requestedTargetId,
    executedTargetId: input.executedTargetId,
    executedSlackUrl: input.executedSlackUrl,
    requestedWorkspaceKey: input.requestedWorkspaceKey,
    executedContextId: extractExecutedContextId(input.result),
  };
}

async function main() {
  const { host, port } = resolveEndpoint();
  console.log(`[Adjutant] CDP endpoint -> ${host}:${port}`);

  const dataDir = resolveDataDir();
  console.log(`[Adjutant] dataDir -> ${dataDir}`);
  const logStartupPhase = (phase: string, meta?: Record<string, unknown>) => {
    if (meta) {
      console.log(`[Adjutant][Startup] ${phase}`, meta);
      return;
    }
    console.log(`[Adjutant][Startup] ${phase}`);
  };
  const runtimeConfig = loadCollectorRuntimeConfig({ dataDir });
  const slackRpcGatewayBootstrap = resolveSlackRpcGatewayBootstrapConfig(process.env);
  let registrarFatal = false;
  const failFastRegistrarError = (message: string, meta?: Record<string, unknown>) => {
    if (registrarFatal) {
      return;
    }
    registrarFatal = true;
    console.error("[Adjutant][SlackRpcWorkspaceRegistrar] fatal", {
      message,
      ...(meta ?? {}),
    });
    void (async () => {
      if (slackRpcGatewayBootstrap.enabled && slackRpcGatewayBootstrap.autoStart) {
        try {
          await stopSlackRpcGateway({
            config: slackRpcGatewayBootstrap,
            cwd: process.cwd(),
            onLog: (message, meta) => {
              logStartupPhase(`slack-rpc-gateway:${message}`, meta);
            },
          });
          console.log("[Adjutant] Slack RPC gateway container stopped");
        } catch (error) {
          console.error("[Adjutant] failed to stop Slack RPC gateway container", {
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
      process.exit(1);
    })();
  };
  const slackRpcWorkspaceRegistrar = createSlackRpcWorkspaceRegistrarFromEnv({
    env: process.env,
    onInfo: (message, meta) => {
      console.log("[Adjutant][SlackRpcWorkspaceRegistrar]", message, meta ?? {});
    },
    onWarn: (message, meta) => {
      failFastRegistrarError(message, meta);
    },
  });
  let activeAutoRegisterWorkspaceKey: string | null = null;

  if (slackRpcGatewayBootstrap.enabled) {
    try {
      await ensureSlackRpcGatewayReady({
        config: slackRpcGatewayBootstrap,
        cwd: process.cwd(),
        onLog: (message, meta) => {
          logStartupPhase(`slack-rpc-gateway:${message}`, meta);
        },
      });
      console.log(
        `[Adjutant] Slack RPC gateway ready base_url=${slackRpcGatewayBootstrap.baseUrl} auto_start=${String(slackRpcGatewayBootstrap.autoStart)}`
      );
    } catch (error) {
      console.error("[Adjutant] Slack RPC gateway bootstrap failed", {
        reason: error instanceof Error ? error.message : String(error),
        baseUrl: slackRpcGatewayBootstrap.baseUrl,
      });
      throw error;
    }
  }
  logStartupPhase("slack-auth-token-registry:configure-start");
  configureSlackAuthTokenRegistry({
    dataDir,
    authTestEnabled: false,
    onWarn: (message, meta) => {
      if (shouldSuppressSlackAuthWarn(message, meta)) {
        return;
      }
      console.warn("[Adjutant][SlackAuthTokenRegistry]", message, meta ?? {});
    },
    onTokenPairReady: async (event) => {
      const activeWorkspaceKey = activeAutoRegisterWorkspaceKey;
      if (!activeWorkspaceKey) {
        return;
      }
      if (event.workspaceKey !== activeWorkspaceKey && !event.aliases.includes(activeWorkspaceKey)) {
        return;
      }
      await slackRpcWorkspaceRegistrar.registerTokenPair(event);
    },
  });
  logStartupPhase("slack-auth-token-registry:configure-done");

  logStartupPhase("jsonl-recovery:scan-start");
  const recoverTargets = await listJsonlFiles(dataDir);
  logStartupPhase("jsonl-recovery:scan-done", { fileCount: recoverTargets.length });
  if (recoverTargets.length > 0) {
    logStartupPhase("jsonl-recovery:repair-start");
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
    logStartupPhase("jsonl-recovery:repair-done", {
      repairedCount: repaired.length,
    });
  }

  const timezone = runtimeConfig.timezone;
  console.log(`[Adjutant] timezone -> ${timezone}`);
  if (runtimeConfig.debugSlackGetCookiesEnabled) {
    console.log("[Adjutant] debug slack getCookies -> enabled");
  }

  const defaultAccountId = SLACK_PENDING_ACCOUNT_ID;
  const writer = new JsonlWriter({ dataDir, defaultAccountId });
  const now = () => new Date();
  const slackCacheBaseDir = resolveSlackCacheBaseDir({
    dataDir,
    accountId: SLACK_PENDING_ACCOUNT_ID,
    fallbackAccountId: SLACK_PENDING_ACCOUNT_ID,
  });
  const channelCachePath = path.join(slackCacheBaseDir, "channel-names-by-team.json");
  const userCachePath = path.join(slackCacheBaseDir, "user-names-by-team.json");
  const debugUiEnabled = runtimeConfig.debugUiEnabled;
  const debugUiPort = runtimeConfig.debugUiPort;
  const debugUi = debugUiEnabled
    ? new DebugUiServer({ port: debugUiPort, channelCachePath, userCachePath })
    : null;
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
    activeAutoRegisterWorkspaceKey = null;
    if (session.stopTokenSync) {
      session.stopTokenSync();
    }
    if (debugUi) {
      debugUi.setSlackAuthTestExecutor(undefined);
      debugUi.setSlackChannelsListExecutor(undefined);
      debugUi.setSlackWorkspaceListProvider(undefined);
    }
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
    if (slackRpcGatewayBootstrap.enabled && slackRpcGatewayBootstrap.autoStart) {
      try {
        await stopSlackRpcGateway({
          config: slackRpcGatewayBootstrap,
          cwd: process.cwd(),
          onLog: (message, meta) => {
            console.log("[Adjutant][Shutdown][SlackRpcGateway]", message, meta ?? {});
          },
        });
        console.log("[Adjutant] Slack RPC gateway container stopped");
      } catch (error) {
        console.error("[Adjutant] failed to stop Slack RPC gateway container", {
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (debugUi) {
      await debugUi.stop();
    }
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  const createSlackAdapterForClient = (client: SlackCdpClient) =>
    new SlackAdapter({
      client,
      now,
      timezone,
      domCaptureDisabled: runtimeConfig.domCaptureDisabled,
      channelCachePath,
      userCachePath,
      debugFetchHookEnabled: rawFetchEventLogger ? true : undefined,
      debugCookieStoreEnabled: runtimeConfig.debugSlackGetCookiesEnabled,
      onDebugEvent,
    });

  const runAuthTestOnActive = async (input: {
    workspaceKey?: string;
    active: ActiveSession;
  }): Promise<Record<string, unknown>> => {
    const requestedWorkspaceKey = input.workspaceKey?.trim();
    const result = await input.active.adapter.runBrowserAuthTest({
      workspaceKey: requestedWorkspaceKey,
    });
    return withCdpExecutionMeta({
      result,
      executedTargetId: input.active.targetId,
      executedSlackUrl: input.active.slackUrl,
      requestedWorkspaceKey,
    });
  };

  const runChannelsListOnActive = async (input: {
    workspaceKey?: string;
    active: ActiveSession;
  }): Promise<Record<string, unknown>> => {
    const requestedWorkspaceKey = input.workspaceKey?.trim();
    const result = await input.active.adapter.runBrowserChannelList({
      workspaceKey: requestedWorkspaceKey,
      limit: 10,
    });
    return withCdpExecutionMeta({
      result,
      executedTargetId: input.active.targetId,
      executedSlackUrl: input.active.slackUrl,
      requestedWorkspaceKey,
    });
  };

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
    const { client, slackUrl, targetId } = await connectToSlackPage(host, port);
    const detachCdpEventLogger = cdpEventLogger
      ? cdpEventLogger.attach(client, { host, port, slackUrl })
      : undefined;
    console.log(`[Adjutant] attached to: ${slackUrl}`);
    const attachedWorkspaceKey = parseWorkspaceTeamIdFromSlackClientUrl(slackUrl);
    activeAutoRegisterWorkspaceKey = attachedWorkspaceKey;
    if (attachedWorkspaceKey) {
      console.log("[Adjutant][SlackRpcWorkspaceRegistrar] auto-register scope updated", {
        workspaceKey: attachedWorkspaceKey,
      });
      const resolvedTokenPair = resolveSlackAuthTokensFromCache({ workspaceKey: attachedWorkspaceKey });
      if (resolvedTokenPair) {
        await slackRpcWorkspaceRegistrar.registerTokenPair({
          workspaceKey: attachedWorkspaceKey,
          aliases: [attachedWorkspaceKey, resolvedTokenPair.workspaceKey],
          accountId: resolvedTokenPair.accountId,
          xoxcToken: resolvedTokenPair.xoxcToken,
          xoxdToken: resolvedTokenPair.xoxdToken,
        });
      }
    } else {
      console.warn(
        "[Adjutant][SlackRpcWorkspaceRegistrar] auto-register scope unavailable: team_id not found in attached URL",
        { slackUrl }
      );
    }
    if (debugUi) {
      debugUi.record({
        source: "system",
        kind: "lifecycle",
        at: new Date().toISOString(),
        payload: { event: "session_attached", slackUrl },
      });
    }

    const adapter = createSlackAdapterForClient(client);
    const ingestor = new SlackIngestor({ adapter, writer });
    const syncTokenSnapshots = () => {
      try {
        const snapshots = adapter.listAuthTokenSnapshots();
        if (snapshots.length === 0) {
          return;
        }
        syncSlackAuthTokenSnapshots({ snapshots });
      } catch (error) {
        console.warn("[Adjutant] failed to sync Slack auth token snapshots", {
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    };
    syncTokenSnapshots();
    const tokenSyncTimer = setInterval(() => {
      syncTokenSnapshots();
    }, AUTH_TOKEN_SYNC_INTERVAL_MS);
    activeSession = {
      client,
      adapter,
      ingestor,
      targetId,
      slackUrl,
      detachCdpEventLogger,
      stopTokenSync: () => clearInterval(tokenSyncTimer),
    };
    if (debugUi) {
      debugUi.setSlackAuthTestExecutor(async ({ workspaceKey }) => {
        const session = activeSession;
        if (!session) {
          throw new Error("slack session is not attached");
        }
        return runAuthTestOnActive({
          workspaceKey,
          active: session,
        });
      });
      debugUi.setSlackChannelsListExecutor(async ({ workspaceKey }) => {
        const session = activeSession;
        if (!session) {
          throw new Error("slack session is not attached");
        }
        return runChannelsListOnActive({
          workspaceKey,
          active: session,
        });
      });
      debugUi.setSlackWorkspaceListProvider(async () => {
        const snapshots = adapter.listAuthTokenSnapshots();
        return snapshots
          .map(summarizeWorkspaceSnapshot)
          .filter(
            (
              item
            ): item is {
              workspaceKey: string;
              label: string;
              hasXoxc: boolean;
              hasXoxd: boolean;
              lastSeenAt: number;
            } => item !== null
          )
          .sort((left, right) => {
            if (right.lastSeenAt !== left.lastSeenAt) {
              return right.lastSeenAt - left.lastSeenAt;
            }
            return left.workspaceKey.localeCompare(right.workspaceKey);
          })
          .map((item) => ({
            workspaceKey: item.workspaceKey,
            label: item.label,
            hasXoxc: item.hasXoxc,
            hasXoxd: item.hasXoxd,
          }));
      });
    }

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
