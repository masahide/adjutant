import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nodeTest, { type TestContext } from "node:test";

import {
  buildCustomToolDefinitions,
  configureSandbox,
} from "../../src/assistant/agent-session-factory.js";
import { createMarkdownSummaryBatchService } from "../../src/assistant/markdown-summary-batch.js";
import { clearMemorySqliteIndexCacheForTest } from "../../src/assistant/memory/sqlite-index.js";
import { AgentAuditLog } from "../../src/control-plane/audit/agent-audit-log.js";
import { readRunAudit } from "../../src/control-plane/audit/audit-reader.js";

const TEST_TIMEOUT_MS = 30_000;

const test = (name: string, fn: (t: TestContext) => Promise<void> | void): void => {
  nodeTest(name, { timeout: TEST_TIMEOUT_MS }, fn);
};

type ToolResult = { details?: unknown };

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return {};
  }
  return value as Record<string, unknown>;
}

test("Phase B integration: memory/sandbox tool wiring and audit summary", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "adjutant-phase-b-int-"));
  t.after(async () => {
    configureSandbox(null);
    clearMemorySqliteIndexCacheForTest();
    await rm(root, { recursive: true, force: true });
  });

  configureSandbox({
    mode: "non-main",
    runSpec: {
      image: "adjutant-sandbox:test",
      hostWorkspaceDir: root,
      containerWorkdir: "/workspace",
      envAllowlist: ["LANG"],
    },
  });

  const mainTools = buildCustomToolDefinitions({
    cwd: root,
    memoryScope: "main",
    memoryWriteEnabled: true,
    stateDir: join(root, "state"),
    phaseBRolloutScope: "all",
  });
  assert.equal(
    mainTools.some((tool) => tool.name === "memory_search"),
    true
  );
  assert.equal(
    mainTools.some((tool) => tool.name === "memory_get"),
    true
  );
  assert.equal(
    mainTools.some((tool) => tool.name === "memory_write"),
    true
  );
  assert.equal(
    mainTools.some((tool) => tool.name === "bash"),
    false
  );

  const spokeTools = buildCustomToolDefinitions({
    cwd: root,
    memoryScope: "spoke",
    memoryWriteEnabled: false,
    stateDir: join(root, "state"),
    phaseBRolloutScope: "all",
  });
  assert.equal(
    spokeTools.some((tool) => tool.name === "bash"),
    true
  );

  const stateDir = join(root, ".adjutant", "state");
  const auditLog = AgentAuditLog.fromStateDir(stateDir);
  auditLog.appendRunStart({
    runId: "run_phase_b_1",
    sessionKey: "main",
    sessionId: "sess_a",
  });
  auditLog.appendToolStart({
    runId: "run_phase_b_1",
    sessionKey: "main",
    toolName: "memory_search",
    toolCallId: "tool_1",
    args: { query: "phase b" },
  });
  auditLog.appendToolEnd({
    runId: "run_phase_b_1",
    sessionKey: "main",
    toolName: "memory_search",
    toolCallId: "tool_1",
    status: "ok",
    resultSummary: { results: [] },
  });
  auditLog.appendRunEnd({
    runId: "run_phase_b_1",
    sessionKey: "main",
    status: "ok",
  });
  await auditLog.flush();

  const summary = await readRunAudit("run_phase_b_1", auditLog);
  assert.equal(summary.runEnded, true);
  assert.equal(summary.runStatus, "ok");
  assert.equal(summary.tools.length, 1);
  assert.equal(summary.tools[0]?.toolCallId, "tool_1");
});

test("Phase B integration: memory_get rejects traversal and symlink paths", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "adjutant-memory-guard-int-"));
  t.after(async () => {
    clearMemorySqliteIndexCacheForTest();
    await rm(root, { recursive: true, force: true });
  });

  const memoryDir = join(root, "memory");
  await mkdir(memoryDir, { recursive: true });
  await writeFile(join(memoryDir, "safe.md"), "safe content\n", "utf8");

  const outsidePath = join(root, "..", "outside-secret.md");
  await writeFile(outsidePath, "secret\n", "utf8");

  const tools = buildCustomToolDefinitions({
    cwd: root,
    memoryScope: "main",
    stateDir: join(root, "state"),
  });
  const memoryGet = tools.find((tool) => tool.name === "memory_get");
  assert.ok(memoryGet);

  const traversal = (await memoryGet.execute(
    "tool_get_1",
    { path: "../outside-secret.md" },
    undefined,
    undefined,
    undefined as never
  )) as ToolResult;
  assert.equal(asRecord(traversal.details).disabled, true);

  try {
    await symlink(outsidePath, join(memoryDir, "linked.md"));
    const bySymlink = (await memoryGet.execute(
      "tool_get_2",
      { path: "memory/linked.md" },
      undefined,
      undefined,
      undefined as never
    )) as ToolResult;
    assert.equal(asRecord(bySymlink.details).disabled, true);
  } catch {
    // symlink unsupported in this environment
  }
});

test("Phase B integration: memory_write -> summary batch -> memory_search", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "adjutant-memory-chain-int-"));
  t.after(async () => {
    clearMemorySqliteIndexCacheForTest();
    await rm(root, { recursive: true, force: true });
  });

  const tools = buildCustomToolDefinitions({
    cwd: root,
    memoryScope: "main",
    memoryWriteEnabled: true,
    stateDir: join(root, "state"),
    phaseBRolloutScope: "all",
  });
  const memoryWrite = tools.find((tool) => tool.name === "memory_write");
  const memorySearch = tools.find((tool) => tool.name === "memory_search");
  assert.ok(memoryWrite);
  assert.ok(memorySearch);

  await memoryWrite.execute(
    "tool_write_1",
    {
      content: "Long term note for phase B integration",
      scope: "long-term",
    },
    undefined,
    undefined,
    undefined as never
  );

  const transcriptsDir = join(root, "transcripts");
  await mkdir(transcriptsDir, { recursive: true });
  await writeFile(
    join(transcriptsDir, "main.jsonl"),
    [
      JSON.stringify({
        role: "user",
        text: "please summarize the current progress",
        timestamp: "2026-02-28T10:00:00.000Z",
      }),
      JSON.stringify({
        role: "assistant",
        text: "phase b summary stored",
        timestamp: "2026-02-28T10:00:05.000Z",
      }),
    ].join("\n"),
    "utf8"
  );

  const service = createMarkdownSummaryBatchService({
    workspaceDir: root,
    timezone: "UTC",
    sessionTranscriptsDir: transcriptsDir,
    watermarkPath: join(root, "state", "agents", "main", "summary-batch-watermark.json"),
  });
  const batch = await service.runOnce();
  assert.equal(batch.processedSessions, 1);

  const search = (await memorySearch.execute(
    "tool_search_1",
    {
      query: "phase b summary",
      maxResults: 5,
    },
    undefined,
    undefined,
    undefined as never
  )) as { details: { results?: Array<{ path: string }> } };

  const results = search.details.results ?? [];
  assert.equal(results.length > 0, true);
  assert.equal(
    results.some(
      (item) =>
        item.path === "MEMORY.md" ||
        item.path.startsWith("memory/") ||
        item.path.endsWith("/MEMORY.md") ||
        item.path.includes("/memory/")
    ),
    true
  );
});
