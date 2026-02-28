import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveMemorySearchRuntimeConfig } from "../../src/assistant/memory-search/config.js";

describe("memory-search-config", () => {
  it("DB パス既定値は <stateDir>/memory/<agentId>.sqlite", () => {
    const config = resolveMemorySearchRuntimeConfig({
      env: {} as NodeJS.ProcessEnv,
      stateDir: "/tmp/adjutant-state",
      agentId: "main",
    });

    assert.equal(config.dbPath, "/tmp/adjutant-state/memory/main.sqlite");
  });

  it("agentId は ADJUTANT_SESSION_AGENT_ID を sanitize して反映する", () => {
    const config = resolveMemorySearchRuntimeConfig({
      env: { ADJUTANT_SESSION_AGENT_ID: "ops/main" } as NodeJS.ProcessEnv,
      stateDir: "/tmp/adjutant-state",
    });

    assert.equal(config.dbPath, "/tmp/adjutant-state/memory/ops_main.sqlite");
  });

  it("ADJUTANT_MEMORY_SEARCH_DB_PATH は既定値より優先される", () => {
    const config = resolveMemorySearchRuntimeConfig({
      env: {
        ADJUTANT_MEMORY_SEARCH_DB_PATH: "/tmp/custom/memory.sqlite",
        ADJUTANT_SESSION_AGENT_ID: "ignored",
      } as NodeJS.ProcessEnv,
      stateDir: "/tmp/adjutant-state",
      agentId: "main",
    });

    assert.equal(config.dbPath, "/tmp/custom/memory.sqlite");
  });
});
