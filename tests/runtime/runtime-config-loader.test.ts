import assert from "node:assert/strict";
import { describe, it } from "node:test";
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
        ADJUTANT_DEBUG_UI: "true",
        ADJUTANT_DEBUG_UI_PORT: "NaN",
        ADJUTANT_CDP_EVENT_LOG: "1",
        ADJUTANT_CDP_EVENT_LOG_MAX_PARAM_CHARS: "-10",
        ADJUTANT_RAW_FETCH_LOG: "yes",
        ADJUTANT_RAW_FETCH_LOG_MAX_PAYLOAD_CHARS: "x",
      } as NodeJS.ProcessEnv,
    });

    assert.equal(config.timezone, "Asia/Tokyo");
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
    assert.equal(config.app.assistant.port, 3200);
    assert.equal(config.app.assistant.host, "0.0.0.0");
    assert.equal(config.app.assistant.dataDir, "data-x");
    assert.equal(config.app.assistant.workspaceDir, "workspace-x");
    assert.equal(config.app.assistant.timezone, "UTC");
    assert.equal(config.app.assistant.model, "gpt-5-mini");
    assert.equal(config.app.routeLlm.enabled, true);
    assert.equal(config.app.routeLlm.model, "gpt-4.1-mini");
    assert.equal(config.app.routeLlm.timeoutMs, 1500);
    assert.equal(config.app.routeLlm.maxConcurrent, 2);
    assert.equal(config.openAiApiKey, "test-key");
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
