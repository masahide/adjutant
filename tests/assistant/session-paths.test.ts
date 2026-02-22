import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolve } from "node:path";
import {
  resolveAdjutantStateDir,
  resolveLegacyWorkspaceSessionsDir,
  resolveSessionAgentId,
  resolveSessionEntriesPath,
  resolveSessionRecordPath,
  resolveSessionTranscriptsDir,
  resolveSummaryBatchWatermarkPath,
} from "../../src/assistant/session-paths.js";

describe("session-paths", () => {
  it("stateDir は ADJUTANT_STATE_DIR を優先する", () => {
    const stateDir = resolveAdjutantStateDir({
      env: { ADJUTANT_STATE_DIR: "/tmp/adjutant-state" } as NodeJS.ProcessEnv,
      dataDir: "/tmp/adjutant-data",
    });
    assert.equal(stateDir, "/tmp/adjutant-state");
  });

  it("stateDir 既定値は dataDir/_assistant", () => {
    const stateDir = resolveAdjutantStateDir({
      env: {} as NodeJS.ProcessEnv,
      dataDir: "/tmp/adjutant-data",
    });
    assert.equal(stateDir, "/tmp/adjutant-data/_assistant");
  });

  it("agentId は sanitize される", () => {
    const agentId = resolveSessionAgentId({
      env: { ADJUTANT_SESSION_AGENT_ID: "ops/main" } as NodeJS.ProcessEnv,
    });
    assert.equal(agentId, "ops_main");
  });

  it("transcriptsDir は override 未指定時に state 配下へ解決される", () => {
    const transcriptsDir = resolveSessionTranscriptsDir({
      stateDir: "/tmp/adjutant-state",
      agentId: "main",
      env: {} as NodeJS.ProcessEnv,
    });
    assert.equal(transcriptsDir, "/tmp/adjutant-state/agents/main/sessions");
  });

  it("transcriptsDir は ADJUTANT_SESSION_TRANSCRIPTS_DIR を優先する", () => {
    const transcriptsDir = resolveSessionTranscriptsDir({
      stateDir: "/tmp/adjutant-state",
      env: { ADJUTANT_SESSION_TRANSCRIPTS_DIR: "/tmp/custom/sessions" } as NodeJS.ProcessEnv,
    });
    assert.equal(transcriptsDir, "/tmp/custom/sessions");
  });

  it("session record path は sessionKey を sanitize して .jsonl を返す", () => {
    const path = resolveSessionRecordPath({
      stateDir: "/tmp/adjutant-state",
      sessionKey: "slack:channel:C123",
      agentId: "main",
      env: {} as NodeJS.ProcessEnv,
    });
    assert.equal(path, "/tmp/adjutant-state/agents/main/sessions/slack_channel_C123.jsonl");
  });

  it("watermark/sessions.json path を state 配下へ解決する", () => {
    assert.equal(
      resolveSummaryBatchWatermarkPath({ stateDir: "/tmp/adjutant-state", agentId: "ops" }),
      "/tmp/adjutant-state/agents/ops/summary-batch-watermark.json"
    );
    assert.equal(
      resolveSessionEntriesPath({ stateDir: "/tmp/adjutant-state", agentId: "ops" }),
      "/tmp/adjutant-state/agents/ops/sessions.json"
    );
  });

  it("legacy workspace sessions path を返す", () => {
    const path = resolveLegacyWorkspaceSessionsDir("/tmp/workspace");
    assert.equal(path, resolve("/tmp/workspace", "memory", "sessions"));
  });
});
