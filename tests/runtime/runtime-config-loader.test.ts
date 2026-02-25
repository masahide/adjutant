import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  ensurePiCacheRetention,
  loadAssistantGatewayRuntimeConfig,
  loadCollectorRuntimeConfig,
  resolveRouteLlmRuntimeConfig,
} from "../../src/runtime/runtime-config-loader.js";

describe("runtime-config-loader", () => {
  it("collector 設定は不正値で既定値へフォールバックする", () => {
    const config = loadCollectorRuntimeConfig({
      dataDir: "/tmp/adjutant-data",
      env: {
        ADJUTANT_TZ: "",
        ADJUTANT_DISABLE_DOM_CAPTURE: "true",
        ADJUTANT_DEBUG_SLACK_GET_COOKIES: "1",
        ADJUTANT_DEBUG_UI: "true",
        ADJUTANT_DEBUG_UI_PORT: "NaN",
        ADJUTANT_CDP_EVENT_LOG: "1",
        ADJUTANT_CDP_EVENT_LOG_MAX_PARAM_CHARS: "-10",
        ADJUTANT_RAW_FETCH_LOG: "yes",
        ADJUTANT_RAW_FETCH_LOG_MAX_PAYLOAD_CHARS: "x",
      } as NodeJS.ProcessEnv,
    });

    assert.equal(config.timezone, "Asia/Tokyo");
    assert.equal(config.domCaptureDisabled, true);
    assert.equal(config.debugSlackGetCookiesEnabled, true);
    assert.equal(config.debugUiEnabled, true);
    assert.equal(config.debugUiPort, 8787);
    assert.equal(config.cdpEventLogEnabled, true);
    assert.equal(config.cdpEventLogMaxParamChars, 0);
    assert.equal(config.rawFetchLogEnabled, true);
    assert.equal(config.rawFetchLogMaxPayloadChars, 0);
    assert.equal(config.cdpEventLogPath, "/tmp/adjutant-data/_debug/cdp-events.jsonl");
    assert.equal(config.rawFetchLogPath, "/tmp/adjutant-data/_debug/raw-fetch.jsonl");
  });

  it("assistant 設定は既存 env キーと既定値契約を維持する", () => {
    const env = {
      ADJUTANT_API_PORT: "3200",
      ADJUTANT_API_HOST: "0.0.0.0",
      ADJUTANT_DATA_DIR: "data-x",
      ADJUTANT_WORKSPACE_DIR: "workspace-x",
      ADJUTANT_TZ: "UTC",
      ADJUTANT_MODEL: "gpt-5-mini",
      ADJUTANT_ROUTE_LLM_ENABLED: "true",
      ADJUTANT_ROUTE_LLM_MODEL: "gpt-4.1-mini",
      ADJUTANT_ROUTE_LLM_TIMEOUT_MS: "1500",
      ADJUTANT_ROUTE_LLM_MAX_CONCURRENT: "2",
      OPENAI_API_KEY: "test-key",
    } as NodeJS.ProcessEnv;

    const config = loadAssistantGatewayRuntimeConfig(env);
    const expectedStateDir = resolve(homedir(), ".adjutant");
    assert.equal(config.app.assistant.port, 3200);
    assert.equal(config.app.assistant.host, "0.0.0.0");
    assert.equal(config.app.assistant.dataDir, "data-x");
    assert.equal(config.app.assistant.workspaceDir, resolve("workspace-x"));
    assert.equal(config.app.assistant.timezone, "UTC");
    assert.equal(config.app.assistant.model, "gpt-5-mini");
    assert.equal(config.app.assistant.logPath, resolve(expectedStateDir, "logs", "assistant.log"));
    assert.equal(config.app.agentAudit.enabled, true);
    assert.equal(
      config.app.agentAudit.path,
      resolve(expectedStateDir, "audit", "agent-audit.ndjson")
    );
    assert.equal(config.app.agentAudit.maxFieldChars, 4000);
    assert.equal(config.app.sessionStorage.stateDir, expectedStateDir);
    assert.equal(config.app.sessionStorage.agentId, "main");
    assert.equal(
      config.app.sessionStorage.transcriptsDir,
      resolve(expectedStateDir, "agents", "main", "sessions")
    );
    assert.equal(
      config.app.sessionStorage.sessionEntriesPath,
      resolve(expectedStateDir, "agents", "main", "sessions", "sessions.json")
    );
    assert.equal(config.app.markdownSummaryBatch.enabled, false);
    assert.equal(config.app.markdownSummaryBatch.intervalMs, 3_600_000);
    assert.equal(config.app.markdownSummaryBatch.messages, 15);
    assert.equal(config.app.markdownSummaryBatch.maxSessions, 200);
    assert.equal(config.app.sandbox.mode, "all");
    assert.equal(config.app.sandbox.docker.image, "adjutant-sandbox:trixie-slim");
    assert.equal(config.app.sandbox.docker.autoBuildImage, true);
    assert.equal(config.app.sandbox.docker.containerPrefix, "adjutant-sandbox");
    assert.equal(config.app.sandbox.docker.workdir, "/workspace");
    assert.deepEqual(config.app.sandbox.docker.envAllowlist, []);
    assert.equal(config.app.routeLlm.enabled, true);
    assert.equal(config.app.routeLlm.model, "gpt-4.1-mini");
    assert.equal(config.app.routeLlm.timeoutMs, 1500);
    assert.equal(config.app.routeLlm.maxConcurrent, 2);
    assert.equal(config.app.slack.defaultAccountId, "default");
    assert.equal(config.app.slack.domCaptureDisabled, false);
    assert.equal(config.corsOrigin, "http://127.0.0.1:5173");
    assert.equal(config.openAiApiKey, "test-key");
  });

  it("assistant 設定は CORS origin と Slack accountId を明示設定できる", () => {
    const config = loadAssistantGatewayRuntimeConfig({
      ADJUTANT_VITE_PORT: "5300",
      ADJUTANT_CORS_ORIGIN: "https://adjutant.example.com",
      ADJUTANT_SLACK_ACCOUNT_ID: "acc-123",
      ADJUTANT_DISABLE_DOM_CAPTURE: "1",
    } as NodeJS.ProcessEnv);

    assert.equal(config.vitePort, 5300);
    assert.equal(config.corsOrigin, "https://adjutant.example.com");
    assert.equal(config.app.slack.defaultAccountId, "acc-123");
    assert.equal(config.app.slack.domCaptureDisabled, true);
  });

  it("assistant 設定は state/session/summary-batch の env override を反映する", () => {
    const config = loadAssistantGatewayRuntimeConfig({
      ADJUTANT_DATA_DIR: "/tmp/adjutant-data",
      ADJUTANT_STATE_DIR: "/tmp/adjutant-state",
      ADJUTANT_SESSION_AGENT_ID: "ops",
      ADJUTANT_SESSION_TRANSCRIPTS_DIR: "/tmp/custom/sessions",
      ADJUTANT_SESSION_ENTRIES_PATH: "/tmp/custom/sessions.json",
      ADJUTANT_MARKDOWN_SUMMARY_BATCH_ENABLED: "1",
      ADJUTANT_MARKDOWN_SUMMARY_BATCH_INTERVAL_MS: "60000",
      ADJUTANT_MARKDOWN_SUMMARY_BATCH_MESSAGES: "20",
      ADJUTANT_MARKDOWN_SUMMARY_BATCH_MAX_SESSIONS: "300",
      ADJUTANT_AGENT_AUDIT_LOG_ENABLED: "0",
      ADJUTANT_AGENT_AUDIT_LOG_PATH: "/tmp/custom/agent-audit.ndjson",
      ADJUTANT_AGENT_AUDIT_MAX_FIELD_CHARS: "1234",
      ADJUTANT_ASSISTANT_LOG_PATH: "/tmp/custom/assistant.log",
    } as NodeJS.ProcessEnv);

    assert.equal(config.app.sessionStorage.stateDir, "/tmp/adjutant-state");
    assert.equal(config.app.sessionStorage.agentId, "ops");
    assert.equal(config.app.sessionStorage.transcriptsDir, "/tmp/custom/sessions");
    assert.equal(config.app.sessionStorage.sessionEntriesPath, "/tmp/custom/sessions.json");
    assert.equal(config.app.assistant.workspaceDir, "/tmp/adjutant-state/workspace");
    assert.equal(config.app.assistant.logPath, "/tmp/custom/assistant.log");
    assert.equal(config.app.agentAudit.enabled, false);
    assert.equal(config.app.agentAudit.path, "/tmp/custom/agent-audit.ndjson");
    assert.equal(config.app.agentAudit.maxFieldChars, 1234);
    assert.equal(config.app.markdownSummaryBatch.enabled, true);
    assert.equal(config.app.markdownSummaryBatch.intervalMs, 60000);
    assert.equal(config.app.markdownSummaryBatch.messages, 20);
    assert.equal(config.app.markdownSummaryBatch.maxSessions, 300);
  });

  it("assistant 設定の workspace/timeline/idempotency 既定値は state 配下を使う", () => {
    const config = loadAssistantGatewayRuntimeConfig({
      ADJUTANT_STATE_DIR: "/tmp/adjutant-state",
    } as NodeJS.ProcessEnv);

    assert.equal(config.app.assistant.dataDir, "/tmp/adjutant-state/data");
    assert.equal(config.app.assistant.workspaceDir, "/tmp/adjutant-state/workspace");
    assert.equal(config.app.assistant.timelinePath, "/tmp/adjutant-state/timeline.jsonl");
    assert.equal(config.app.idempotency.storePath, "/tmp/adjutant-state/idempotency.jsonl");
  });

  it("assistant 設定は sandbox env override を反映する", () => {
    const config = loadAssistantGatewayRuntimeConfig({
      ADJUTANT_SANDBOX_MODE: "all",
      ADJUTANT_SANDBOX_IMAGE: "sandbox:test",
      ADJUTANT_SANDBOX_AUTO_BUILD_IMAGE: "0",
      ADJUTANT_SANDBOX_CONTAINER_PREFIX: "sandbox-runner",
      ADJUTANT_SANDBOX_WORKDIR: "/work",
      ADJUTANT_SANDBOX_ENV_ALLOWLIST: "OPENAI_API_KEY, AWS_REGION",
      ADJUTANT_SANDBOX_NETWORK: "none",
      ADJUTANT_SANDBOX_MEMORY: "1g",
      ADJUTANT_SANDBOX_PIDS_LIMIT: "512",
    } as NodeJS.ProcessEnv);

    assert.equal(config.app.sandbox.mode, "all");
    assert.equal(config.app.sandbox.docker.image, "sandbox:test");
    assert.equal(config.app.sandbox.docker.autoBuildImage, false);
    assert.equal(config.app.sandbox.docker.containerPrefix, "sandbox-runner");
    assert.equal(config.app.sandbox.docker.workdir, "/work");
    assert.deepEqual(config.app.sandbox.docker.envAllowlist, ["OPENAI_API_KEY", "AWS_REGION"]);
    assert.equal(config.app.sandbox.docker.network, "none");
    assert.equal(config.app.sandbox.docker.memory, "1g");
    assert.equal(config.app.sandbox.docker.pidsLimit, 512);
  });

  it("route LLM 設定は不正値を既定値へフォールバックする", () => {
    const config = resolveRouteLlmRuntimeConfig({
      ADJUTANT_ROUTE_LLM_ENABLED: "invalid",
      ADJUTANT_ROUTE_LLM_MODEL: "",
      ADJUTANT_ROUTE_LLM_TIMEOUT_MS: "0",
      ADJUTANT_ROUTE_LLM_MAX_CONCURRENT: "-1",
    } as NodeJS.ProcessEnv);

    assert.equal(config.enabled, false);
    assert.equal(config.model, "gpt-5-mini");
    assert.equal(config.routeLlmTimeoutMs, 1000);
    assert.equal(config.maxConcurrentRouteLlm, 1);
  });

  it("PI_CACHE_RETENTION が未設定なら long をセットする", () => {
    const env = {} as NodeJS.ProcessEnv;
    const retention = ensurePiCacheRetention(env);

    assert.equal(retention, "long");
    assert.equal(env.PI_CACHE_RETENTION, "long");
  });
});
