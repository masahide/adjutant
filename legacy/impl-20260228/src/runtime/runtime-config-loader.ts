import { join, resolve } from "node:path";
import type { AppRuntimeConfig } from "./app-runtime-config.js";
import {
  parseBooleanEnv,
  parseNonNegativeIntEnv,
  parsePositiveIntEnv,
  parseStringEnv,
} from "./env-parsers.js";
import {
  resolveAdjutantStateDir,
  resolveAdjutantWorkspaceDir,
  resolveSessionAgentId,
  resolveSessionEntriesPath,
  resolveSessionTranscriptsDir,
} from "../assistant/session-paths.js";
import { normalizeAccountId, resolveDefaultDataDir } from "./data-paths.js";
import { resolveSandboxConfig } from "../sandbox/config.js";

const DEFAULT_ROUTE_LLM_MODEL = "gpt-5.4-mini";
const DEFAULT_ROUTE_LLM_TIMEOUT_MS = 1_000;
const DEFAULT_ROUTE_LLM_MAX_CONCURRENT = 1;
const DEFAULT_DUAL_WRITE_RETRY_INTERVAL_MS = 5_000;

export type RouteLlmRuntimeConfig = {
  enabled: boolean;
  provider: "openai";
  model: string;
  routeLlmTimeoutMs: number;
  maxConcurrentRouteLlm: number;
};

export type CollectorRuntimeConfig = {
  timezone: string;
  domCaptureDisabled: boolean;
  debugUiEnabled: boolean;
  debugUiPort: number;
  cdpEventLogEnabled: boolean;
  cdpEventLogPath: string;
  cdpEventLogMaxParamChars: number;
  rawFetchLogEnabled: boolean;
  rawFetchLogPath: string;
  rawFetchLogMaxPayloadChars: number;
};

export type AssistantGatewayRuntimeConfig = {
  app: AppRuntimeConfig;
  model?: string;
  channelsConfigPath?: string;
  dualWriteRetryIntervalMs: number;
  vitePort: number;
  corsOrigin: string;
  openAiApiKey?: string;
  piCacheRetention: string;
};

export function resolveRouteLlmRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env
): RouteLlmRuntimeConfig {
  return {
    enabled: parseBooleanEnv(env.ADJUTANT_ROUTE_LLM_ENABLED, false),
    provider: "openai",
    model: parseStringEnv(env.ADJUTANT_ROUTE_LLM_MODEL, DEFAULT_ROUTE_LLM_MODEL),
    routeLlmTimeoutMs: parsePositiveIntEnv(
      env.ADJUTANT_ROUTE_LLM_TIMEOUT_MS,
      DEFAULT_ROUTE_LLM_TIMEOUT_MS
    ),
    maxConcurrentRouteLlm: parsePositiveIntEnv(
      env.ADJUTANT_ROUTE_LLM_MAX_CONCURRENT,
      DEFAULT_ROUTE_LLM_MAX_CONCURRENT
    ),
  };
}

export function loadCollectorRuntimeConfig(params: {
  dataDir: string;
  env?: NodeJS.ProcessEnv;
}): CollectorRuntimeConfig {
  const env = params.env ?? process.env;
  const dataDir = params.dataDir;

  const cdpEventLogPathEnv = env.ADJUTANT_CDP_EVENT_LOG_PATH?.trim();
  const rawFetchLogPathEnv = env.ADJUTANT_RAW_FETCH_LOG_PATH?.trim();

  return {
    timezone: parseStringEnv(env.ADJUTANT_TZ, "Asia/Tokyo"),
    domCaptureDisabled: parseBooleanEnv(env.ADJUTANT_DISABLE_DOM_CAPTURE, false),
    debugUiEnabled: parseBooleanEnv(env.ADJUTANT_DEBUG_UI, false),
    debugUiPort: parsePositiveIntEnv(env.ADJUTANT_DEBUG_UI_PORT, 8787),
    cdpEventLogEnabled: parseBooleanEnv(env.ADJUTANT_CDP_EVENT_LOG, false),
    cdpEventLogPath: cdpEventLogPathEnv
      ? resolve(cdpEventLogPathEnv)
      : join(dataDir, "_debug", "cdp-events.jsonl"),
    cdpEventLogMaxParamChars: parseNonNegativeIntEnv(env.ADJUTANT_CDP_EVENT_LOG_MAX_PARAM_CHARS, 0),
    rawFetchLogEnabled: parseBooleanEnv(env.ADJUTANT_RAW_FETCH_LOG, false),
    rawFetchLogPath: rawFetchLogPathEnv
      ? resolve(rawFetchLogPathEnv)
      : join(dataDir, "_debug", "raw-fetch.jsonl"),
    rawFetchLogMaxPayloadChars: parseNonNegativeIntEnv(
      env.ADJUTANT_RAW_FETCH_LOG_MAX_PAYLOAD_CHARS,
      0
    ),
  };
}

export function ensurePiCacheRetention(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PI_CACHE_RETENTION?.trim();
  if (configured) {
    return configured;
  }
  env.PI_CACHE_RETENTION = "long";
  return "long";
}

export function loadAssistantGatewayRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env
): AssistantGatewayRuntimeConfig {
  const stateDir = resolveAdjutantStateDir({ env });
  const dataDir = parseStringEnv(env.ADJUTANT_DATA_DIR, resolveDefaultDataDir(stateDir));
  const workspaceDir = resolveAdjutantWorkspaceDir({ env, stateDir });
  const sessionAgentId = resolveSessionAgentId({ env });
  const sessionTranscriptsDir = resolveSessionTranscriptsDir({
    env,
    stateDir,
    agentId: sessionAgentId,
  });
  const sessionEntriesPath =
    env.ADJUTANT_SESSION_ENTRIES_PATH?.trim() ||
    resolveSessionEntriesPath({ stateDir, agentId: sessionAgentId });
  const timezone = parseStringEnv(env.ADJUTANT_TZ, "Asia/Tokyo");
  const vitePort = parsePositiveIntEnv(env.ADJUTANT_VITE_PORT, 5173);
  const timelinePath = env.ADJUTANT_TIMELINE_PATH?.trim() || join(stateDir, "timeline.jsonl");
  const agentAuditLogPath =
    env.ADJUTANT_AGENT_AUDIT_LOG_PATH?.trim() || join(stateDir, "audit", "agent-audit.ndjson");
  const idempotencyStorePath =
    env.ADJUTANT_IDEMPOTENCY_STORE_PATH?.trim() || join(stateDir, "idempotency.jsonl");
  const slackAccountId = normalizeAccountId(
    parseStringEnv(env.ADJUTANT_SLACK_ACCOUNT_ID, "default")
  );
  const corsOrigin = env.ADJUTANT_CORS_ORIGIN?.trim() || `http://127.0.0.1:${String(vitePort)}`;
  const routeLlm = resolveRouteLlmRuntimeConfig(env);
  const sandbox = resolveSandboxConfig(env);

  return {
    app: {
      assistant: {
        host: parseStringEnv(env.ADJUTANT_API_HOST, "127.0.0.1"),
        port: parsePositiveIntEnv(env.ADJUTANT_API_PORT, 3100),
        dataDir,
        workspaceDir,
        timezone,
        model: env.ADJUTANT_MODEL?.trim() || undefined,
        timelinePath,
      },
      agentAudit: {
        enabled: parseBooleanEnv(env.ADJUTANT_AGENT_AUDIT_LOG_ENABLED, true),
        path: resolve(agentAuditLogPath),
        maxFieldChars: parsePositiveIntEnv(env.ADJUTANT_AGENT_AUDIT_MAX_FIELD_CHARS, 4000),
      },
      sessionStorage: {
        stateDir,
        agentId: sessionAgentId,
        transcriptsDir: sessionTranscriptsDir,
        sessionEntriesPath,
      },
      markdownSummaryBatch: {
        enabled: parseBooleanEnv(env.ADJUTANT_MARKDOWN_SUMMARY_BATCH_ENABLED, false),
        intervalMs: parsePositiveIntEnv(env.ADJUTANT_MARKDOWN_SUMMARY_BATCH_INTERVAL_MS, 3_600_000),
        messages: parsePositiveIntEnv(env.ADJUTANT_MARKDOWN_SUMMARY_BATCH_MESSAGES, 15),
        maxSessions: parsePositiveIntEnv(env.ADJUTANT_MARKDOWN_SUMMARY_BATCH_MAX_SESSIONS, 200),
      },
      sandbox,
      idempotency: {
        storePath: idempotencyStorePath,
        maxEntries: parsePositiveIntEnv(env.ADJUTANT_IDEMPOTENCY_MAX_ENTRIES, 5000),
        failureMode: env.ADJUTANT_IDEMPOTENCY_STORE_FAILURE_MODE === "closed" ? "closed" : "open",
      },
      sse: {
        replayBufferSize: parsePositiveIntEnv(env.ADJUTANT_SSE_REPLAY_BUFFER_SIZE, 512),
        replayMaxAgeMs: parsePositiveIntEnv(env.ADJUTANT_SSE_REPLAY_MAX_AGE_MS, 300_000),
      },
      routeLlm: {
        enabled: routeLlm.enabled,
        provider: routeLlm.provider,
        model: routeLlm.model,
        timeoutMs: routeLlm.routeLlmTimeoutMs,
        maxConcurrent: routeLlm.maxConcurrentRouteLlm,
      },
      heartbeat: {
        intervalMs: parsePositiveIntEnv(env.ADJUTANT_HEARTBEAT_INTERVAL_MS, 1_800_000),
        staleMs: parsePositiveIntEnv(env.ADJUTANT_HEARTBEAT_STALE_MS, 900_000),
      },
      slack: {
        retryBaseMs: parsePositiveIntEnv(env.ADJUTANT_SLACK_RETRY_BASE_MS, 1000),
        retryMaxMs: parsePositiveIntEnv(env.ADJUTANT_SLACK_RETRY_MAX_MS, 10000),
        defaultAccountId: slackAccountId,
        domCaptureDisabled: parseBooleanEnv(env.ADJUTANT_DISABLE_DOM_CAPTURE, false),
      },
    },
    channelsConfigPath: env.ADJUTANT_CHANNELS_CONFIG_PATH?.trim() || undefined,
    dualWriteRetryIntervalMs: parseNonNegativeIntEnv(
      env.ADJUTANT_DUAL_WRITE_RETRY_INTERVAL_MS,
      DEFAULT_DUAL_WRITE_RETRY_INTERVAL_MS
    ),
    vitePort,
    corsOrigin,
    openAiApiKey: env.OPENAI_API_KEY?.trim() || undefined,
    piCacheRetention: ensurePiCacheRetention(env),
  };
}
