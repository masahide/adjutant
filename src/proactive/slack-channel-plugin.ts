import type { IngestionAdapter } from "../core/adapter.js";
import type { NormalizedEvent } from "../core/events.js";
import { JsonlWriter } from "../io/jsonlWriter.js";
import { normalizeAccountId, resolveSlackCacheBaseDir } from "../runtime/data-paths.js";
import { resolveEndpoint, type CdpEndpoint } from "../runtime/config.js";
import { computeFullJitterDelayMs } from "../runtime/retry-policy.js";
import { connectToSlackPage, type SlackCdpClient } from "../runtime/slackConnection.js";
import { SlackAdapter } from "../slack/adapter.js";
import type { ChannelGatewayContext, ChannelIngestionPlugin } from "./channel-plugin.js";
import { join } from "node:path";

type JsonlEventWriter = {
  append: (event: NormalizedEvent) => Promise<void>;
};

type SlackAdapterFactoryInput = {
  client: SlackCdpClient;
  timezone: string;
  dataDir: string;
  accountId: string;
  domCaptureDisabled: boolean;
};

type SlackChannelPluginOptions = {
  id?: string;
  channelId?: string;
  dataDir: string;
  timezone?: string;
  accountIds?: string[];
  defaultAccountId?: string;
  retryBaseMs?: number;
  retryMaxMs?: number;
  domCaptureDisabled?: boolean;
  resolveEndpoint?: () => CdpEndpoint;
  connectToSlackPage?: (
    host: string,
    port: number
  ) => Promise<{ client: SlackCdpClient; slackUrl: string }>;
  createAdapter?: (input: SlackAdapterFactoryInput) => IngestionAdapter;
  createWriter?: (dataDir: string, defaultAccountId: string) => JsonlEventWriter;
  sleep?: (ms: number) => Promise<void>;
  nowMs?: () => number;
  random?: () => number;
  onWarn?: (message: string, meta?: Record<string, unknown>) => void;
};

type DisconnectAwareClient = {
  on: (event: "disconnect", handler: () => void) => void;
  off?: (event: "disconnect", handler: () => void) => void;
  removeListener?: (event: "disconnect", handler: () => void) => void;
  close?: () => Promise<void> | void;
};

type ActiveAccountSession = {
  client: DisconnectAwareClient;
  adapter: IngestionAdapter;
};

const DEFAULT_RETRY_BASE_MS = 1000;
const DEFAULT_RETRY_MAX_MS = 10000;

function normalizeRetryMs(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.floor(value as number));
}

function toReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveAccountIds(options: SlackChannelPluginOptions): string[] {
  const explicit = (options.accountIds ?? [])
    .map((value) => normalizeAccountId(value, "default"))
    .filter(Boolean);
  if (explicit.length > 0) {
    return explicit;
  }
  const fallback = normalizeAccountId(options.defaultAccountId, "default");
  return [fallback];
}

function attachAccountId(event: NormalizedEvent, accountId: string): NormalizedEvent {
  const normalizedAccountId = normalizeAccountId(accountId, "default");
  return {
    ...event,
    meta: {
      ...(event.meta ?? {}),
      account_id: normalizedAccountId,
    },
  };
}

async function closeClient(
  client: DisconnectAwareClient,
  onWarn?: (message: string, meta?: Record<string, unknown>) => void
): Promise<void> {
  if (typeof client.close !== "function") {
    return;
  }
  try {
    await client.close();
  } catch (error) {
    onWarn?.("slack-plugin-close-client-failed", { reason: toReason(error) });
  }
}

async function waitForDisconnectOrAbort(
  client: DisconnectAwareClient,
  abortSignal: AbortSignal
): Promise<"disconnect" | "abort"> {
  if (abortSignal.aborted) {
    return "abort";
  }
  return await new Promise<"disconnect" | "abort">((resolve) => {
    const finish = (reason: "disconnect" | "abort") => {
      if (typeof client.off === "function") {
        client.off("disconnect", handleDisconnect);
      }
      if (typeof client.removeListener === "function") {
        client.removeListener("disconnect", handleDisconnect);
      }
      abortSignal.removeEventListener("abort", handleAbort);
      resolve(reason);
    };
    const handleDisconnect = () => finish("disconnect");
    const handleAbort = () => finish("abort");

    client.on("disconnect", handleDisconnect);
    abortSignal.addEventListener("abort", handleAbort, { once: true });
  });
}

function createDefaultAdapterFactory(
  options: SlackChannelPluginOptions
): (input: SlackAdapterFactoryInput) => IngestionAdapter {
  return (input) => {
    const cacheBase = resolveSlackCacheBaseDir({
      dataDir: options.dataDir,
      accountId: input.accountId,
      fallbackAccountId: options.defaultAccountId ?? "default",
    });
    return new SlackAdapter({
      client: input.client,
      timezone: input.timezone,
      domCaptureDisabled: input.domCaptureDisabled,
      now: () => new Date(),
      channelCachePath: join(cacheBase, "channel-names-by-team.json"),
      userCachePath: join(cacheBase, "user-names-by-team.json"),
    });
  };
}

export function createSlackChannelPlugin(
  options: SlackChannelPluginOptions
): ChannelIngestionPlugin<unknown> {
  const pluginId = options.id?.trim() || "slack";
  const channelId = options.channelId?.trim() || "slack";
  const timezone = options.timezone?.trim() || "Asia/Tokyo";
  const retryBaseMs = normalizeRetryMs(options.retryBaseMs, DEFAULT_RETRY_BASE_MS);
  const retryMaxMs = Math.max(
    normalizeRetryMs(options.retryMaxMs, DEFAULT_RETRY_MAX_MS),
    retryBaseMs
  );
  const domCaptureDisabled = options.domCaptureDisabled ?? false;
  const endpointResolver = options.resolveEndpoint ?? resolveEndpoint;
  const connectFn = options.connectToSlackPage ?? connectToSlackPage;
  const createAdapter = options.createAdapter ?? createDefaultAdapterFactory(options);
  const writer = (
    options.createWriter ??
    ((dataDir, defaultAccountId) => new JsonlWriter({ dataDir, defaultAccountId }))
  )(options.dataDir, normalizeAccountId(options.defaultAccountId, "default"));
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const nowMs = options.nowMs ?? (() => Date.now());
  const random = options.random ?? Math.random;

  const activeSessions = new Map<string, ActiveAccountSession>();
  const accountIds = resolveAccountIds(options);

  const stopActiveSession = async (accountId: string): Promise<void> => {
    const active = activeSessions.get(accountId);
    if (!active) {
      return;
    }
    activeSessions.delete(accountId);
    if (typeof active.adapter.stop === "function") {
      try {
        await active.adapter.stop();
      } catch (error) {
        options.onWarn?.("slack-plugin-stop-adapter-failed", {
          accountId,
          reason: toReason(error),
        });
      }
    }
    await closeClient(active.client, options.onWarn);
  };

  const startAccount = async (ctx: ChannelGatewayContext<unknown>): Promise<void> => {
    let retryCount = 0;
    while (!ctx.abortSignal.aborted) {
      try {
        const endpoint = endpointResolver();
        const { client, slackUrl } = await connectFn(endpoint.host, endpoint.port);
        const adapter = createAdapter({
          client,
          timezone,
          dataDir: options.dataDir,
          accountId: ctx.accountId,
          domCaptureDisabled,
        });
        activeSessions.set(ctx.accountId, { client, adapter });
        ctx.setStatus({
          ...ctx.getStatus(),
          accountId: ctx.accountId,
          running: true,
          connected: true,
          lastError: null,
          lastStartAt: nowMs(),
        });
        await adapter.start(async (event) => {
          const withAccount = attachAccountId(event, ctx.accountId);
          await writer.append(withAccount);
          await ctx.emit({
            accountId: ctx.accountId,
            channelId,
            event: withAccount,
          });
        });
        retryCount = 0;
        const reason = await waitForDisconnectOrAbort(client, ctx.abortSignal);
        if (reason === "disconnect" && !ctx.abortSignal.aborted) {
          options.onWarn?.("slack-plugin-disconnected", {
            accountId: ctx.accountId,
            slackUrl,
          });
        }
      } catch (error) {
        const reason = toReason(error);
        ctx.setStatus({
          ...ctx.getStatus(),
          accountId: ctx.accountId,
          running: true,
          connected: false,
          lastError: reason,
        });
        options.onWarn?.("slack-plugin-start-failed", {
          accountId: ctx.accountId,
          reason,
        });
      } finally {
        await stopActiveSession(ctx.accountId);
        ctx.setStatus({
          ...ctx.getStatus(),
          accountId: ctx.accountId,
          connected: false,
          lastStopAt: nowMs(),
        });
      }

      if (ctx.abortSignal.aborted) {
        break;
      }

      retryCount += 1;
      const delayMs = computeFullJitterDelayMs({
        attempt: retryCount,
        baseMs: retryBaseMs,
        capMs: retryMaxMs,
        random,
      });
      await sleep(delayMs);
    }
  };

  const stopAccount = async (ctx: ChannelGatewayContext<unknown>): Promise<void> => {
    await stopActiveSession(ctx.accountId);
    ctx.setStatus({
      ...ctx.getStatus(),
      accountId: ctx.accountId,
      connected: false,
      lastStopAt: nowMs(),
    });
  };

  return {
    id: pluginId,
    listAccountIds: () => [...accountIds],
    startAccount,
    stopAccount,
  };
}
