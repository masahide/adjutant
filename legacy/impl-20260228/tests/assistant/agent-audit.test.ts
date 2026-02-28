import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  auditRunStart,
  auditToolEnd,
  auditToolStart,
  configureAgentAuditLogger,
  flushAgentAuditLoggerForTest,
  resetAgentAuditLoggerForTest,
} from "../../src/assistant/agent-audit.js";

describe("agent-audit", () => {
  afterEach(() => {
    resetAgentAuditLoggerForTest();
  });

  it("ツール引数の機微キーをマスクして保存する", async () => {
    const dir = await mkdtemp(`${tmpdir()}/adjutant-audit-`);
    try {
      const path = join(dir, "audit", "agent-audit.ndjson");
      configureAgentAuditLogger({
        enabled: true,
        path,
        maxFieldChars: 4000,
        now: () => new Date("2026-02-23T00:00:00.000Z"),
      });

      auditToolStart({
        scope: { runId: "run-1", sessionKey: "main" },
        toolName: "memory_search",
        args: {
          query: "release note",
          apiKey: "secret-key",
          nested: {
            authorization: "Bearer token",
          },
        },
      });
      await flushAgentAuditLoggerForTest();

      const lines = (await readFile(path, "utf8")).trim().split("\n");
      assert.equal(lines.length, 1);
      const event = JSON.parse(lines[0]) as {
        type: string;
        args?: Record<string, unknown>;
      };
      assert.equal(event.type, "tool.start");
      assert.deepEqual(event.args, {
        query: "release note",
        apiKey: "***",
        nested: {
          authorization: "***",
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("長いフィールドは truncate して記録する", async () => {
    const dir = await mkdtemp(`${tmpdir()}/adjutant-audit-`);
    try {
      const path = join(dir, "audit", "agent-audit.ndjson");
      configureAgentAuditLogger({
        enabled: true,
        path,
        maxFieldChars: 40,
      });

      auditToolEnd({
        scope: { runId: "run-1", sessionKey: "main" },
        toolName: "memory_get",
        status: "ok",
        resultSummary: {
          text: "x".repeat(200),
        },
      });
      await flushAgentAuditLoggerForTest();

      const lines = (await readFile(path, "utf8")).trim().split("\n");
      assert.equal(lines.length, 1);
      const event = JSON.parse(lines[0]) as {
        type: string;
        truncated?: boolean;
        resultSummary?: { _truncated?: boolean; preview?: string; originalType?: string };
      };
      assert.equal(event.type, "tool.end");
      assert.equal(event.truncated, true);
      assert.equal(event.resultSummary?._truncated, true);
      assert.equal(typeof event.resultSummary?.preview, "string");
      assert.equal(event.resultSummary?.preview?.includes("(truncated)"), true);
      assert.equal(event.resultSummary?.originalType, "object");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("tool.end は error と resultSummary を分離して記録する", async () => {
    const dir = await mkdtemp(`${tmpdir()}/adjutant-audit-`);
    try {
      const path = join(dir, "audit", "agent-audit.ndjson");
      configureAgentAuditLogger({
        enabled: true,
        path,
        maxFieldChars: 4000,
      });

      auditToolEnd({
        scope: { runId: "run-1", sessionKey: "main" },
        toolName: "memory_search",
        status: "error",
        resultSummary: { results: [] },
        error: "tool failed",
      });
      await flushAgentAuditLoggerForTest();

      const lines = (await readFile(path, "utf8")).trim().split("\n");
      assert.equal(lines.length, 1);
      const event = JSON.parse(lines[0]) as {
        type: string;
        error?: string;
        resultSummary?: Record<string, unknown>;
      };
      assert.equal(event.type, "tool.end");
      assert.equal(event.error, "tool failed");
      assert.deepEqual(event.resultSummary, { results: [] });
      assert.equal("error" in (event.resultSummary ?? {}), false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("保存先ディレクトリが未作成でも ENOENT リトライで記録できる", async () => {
    const dir = await mkdtemp(`${tmpdir()}/adjutant-audit-`);
    try {
      const path = join(dir, "nested", "dir", "agent-audit.ndjson");
      configureAgentAuditLogger({
        enabled: true,
        path,
        maxFieldChars: 4000,
      });

      auditRunStart({
        scope: { runId: "run-enoent", sessionKey: "main" },
      });
      await flushAgentAuditLoggerForTest();

      const lines = (await readFile(path, "utf8")).trim().split("\n");
      assert.equal(lines.length, 1);
      const event = JSON.parse(lines[0]) as { type: string; runId: string };
      assert.equal(event.type, "run.start");
      assert.equal(event.runId, "run-enoent");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
