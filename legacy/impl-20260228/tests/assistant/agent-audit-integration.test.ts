import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configureAgentAuditLogger,
  resetAgentAuditLoggerForTest,
} from "../../src/assistant/agent-audit.js";
import {
  resetAgentRunnerForTest,
  runAgent,
  setAgentRunnerRuntimeForTest,
} from "../../src/assistant/agent-runner.js";

function inMemorySessionStoreRuntime() {
  const store: Record<string, Record<string, unknown>> = {};
  return {
    loadSessionEntryStore: async () => ({ path: "/tmp/none", store }),
    saveSessionEntryStore: async () => "/tmp/none",
    repairSessionData: async () => false,
  };
}

describe("agent-audit integration", () => {
  afterEach(() => {
    resetAgentAuditLoggerForTest();
    resetAgentRunnerForTest();
  });

  it("runAgent で run/tool の監査イベントが NDJSON に出力される", async () => {
    let listener: ((event: unknown) => void) | undefined;
    const workspaceDir = await mkdtemp(`${tmpdir()}/adjutant-audit-run-`);
    try {
      const auditPath = join(workspaceDir, "audit", "agent-audit.ndjson");
      configureAgentAuditLogger({
        enabled: true,
        path: auditPath,
        maxFieldChars: 4000,
      });

      setAgentRunnerRuntimeForTest({
        ...inMemorySessionStoreRuntime(),
        nowMs: () => Date.now(),
        acquireLock: async () => () => undefined,
        openSessionManager: () => ({}),
        createSession: async () => ({
          session: {
            subscribe: (cb) => {
              listener = cb;
              return () => undefined;
            },
            prompt: async () => {
              listener?.({
                type: "tool_execution_start",
                toolName: "memory_search",
                args: { query: "release note" },
              });
              listener?.({
                type: "tool_execution_end",
                toolName: "memory_search",
                result: { results: [] },
              });
              listener?.({
                type: "message_update",
                assistantMessageEvent: { type: "text_delta", delta: "done" },
              });
            },
            dispose: () => undefined,
          },
        }),
      });

      await runAgent({
        runId: "run-audit-1",
        sessionKey: "main",
        prompt: "hello",
        workspaceDir,
        timezone: "UTC",
        sessionEntriesPath: join(workspaceDir, "sessions.json"),
        memoryScope: "spoke",
      });

      const records = (await readFile(auditPath, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { type: string; runId: string; sessionKey: string });

      const types = records.map((item) => item.type);
      assert.deepEqual(types, ["run.start", "tool.start", "tool.end", "run.end"]);
      assert.equal(
        records.every((item) => item.runId === "run-audit-1"),
        true
      );
      assert.equal(
        records.every((item) => item.sessionKey === "main"),
        true
      );
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("監査ログ書き込み失敗時も runAgent 本体は継続する", async () => {
    const workspaceDir = await mkdtemp(`${tmpdir()}/adjutant-audit-run-`);
    try {
      // ディレクトリをパスとして渡して append を失敗させる
      configureAgentAuditLogger({
        enabled: true,
        path: workspaceDir,
        maxFieldChars: 4000,
      });

      setAgentRunnerRuntimeForTest({
        ...inMemorySessionStoreRuntime(),
        acquireLock: async () => () => undefined,
        openSessionManager: () => ({}),
        createSession: async () => ({
          session: {
            subscribe: () => () => undefined,
            prompt: async () => undefined,
            dispose: () => undefined,
          },
        }),
      });

      const result = await runAgent({
        runId: "run-audit-fail-open",
        sessionKey: "main",
        prompt: "hello",
        workspaceDir,
        timezone: "UTC",
        sessionEntriesPath: join(workspaceDir, "sessions.json"),
        memoryScope: "spoke",
      });

      assert.equal(result.runId, "run-audit-fail-open");
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("model unavailable の早期失敗でも run.end を記録する", async () => {
    const workspaceDir = await mkdtemp(`${tmpdir()}/adjutant-audit-run-`);
    try {
      const auditPath = join(workspaceDir, "audit", "agent-audit.ndjson");
      configureAgentAuditLogger({
        enabled: true,
        path: auditPath,
        maxFieldChars: 4000,
      });
      setAgentRunnerRuntimeForTest({
        ...inMemorySessionStoreRuntime(),
        isModelAvailable: () => false,
      });

      await assert.rejects(
        runAgent({
          runId: "run-model-unavailable",
          sessionKey: "main",
          prompt: "hello",
          model: "gpt-5.4-mini",
          workspaceDir,
          timezone: "UTC",
          sessionEntriesPath: join(workspaceDir, "sessions.json"),
          memoryScope: "spoke",
        }),
        /model unavailable/
      );

      const records = (await readFile(auditPath, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { type: string; status?: string; runId: string });
      assert.deepEqual(
        records.map((item) => item.type),
        ["run.start", "run.end"]
      );
      assert.equal(records[1]?.status, "error");
      assert.equal(records[1]?.runId, "run-model-unavailable");
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("長いエラーでも run.end.error に残る", async () => {
    const workspaceDir = await mkdtemp(`${tmpdir()}/adjutant-audit-run-`);
    try {
      const auditPath = join(workspaceDir, "audit", "agent-audit.ndjson");
      configureAgentAuditLogger({
        enabled: true,
        path: auditPath,
        maxFieldChars: 60,
      });

      const longError = `fatal:${"x".repeat(500)}`;
      setAgentRunnerRuntimeForTest({
        ...inMemorySessionStoreRuntime(),
        acquireLock: async () => () => undefined,
        openSessionManager: () => ({}),
        createSession: async () => ({
          session: {
            subscribe: () => () => undefined,
            prompt: async () => {
              throw new Error(longError);
            },
            dispose: () => undefined,
          },
        }),
      });

      await assert.rejects(
        runAgent({
          runId: "run-long-error",
          sessionKey: "main",
          prompt: "hello",
          workspaceDir,
          timezone: "UTC",
          sessionEntriesPath: join(workspaceDir, "sessions.json"),
          memoryScope: "spoke",
        })
      );

      const records = (await readFile(auditPath, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { type: string; error?: string });
      const runEnd = records.find((item) => item.type === "run.end");
      assert.equal(typeof runEnd?.error, "string");
      assert.equal((runEnd?.error?.length ?? 0) > 0, true);
      assert.equal(runEnd?.error?.includes("(truncated)"), true);
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
