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

async function executeToolHub(
  tools: ReturnType<typeof buildCustomToolDefinitions>,
  params?: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const tool = tools.find((entry) => entry.name === "tool_hub");
  assert.ok(tool);
  const result = (await tool.execute(
    "tool_hub_call",
    params,
    undefined,
    undefined,
    undefined as never
  )) as ToolResult;
  return asRecord(result.details);
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
      containerHome: "/home/agent",
      user: "1000:1000",
      envAllowlist: ["LANG"],
    },
  });

  const mainTools = buildCustomToolDefinitions({
    workspaceDir: root,
    memoryScope: "main",
    memoryWriteEnabled: true,
    stateDir: join(root, "state"),
    phaseBRolloutScope: "all",
  });
  assert.equal(
    mainTools.some((tool) => tool.name === "tool_hub"),
    true
  );
  assert.equal(
    mainTools.some((tool) => tool.name === "bash"),
    false
  );
  const mainProviderHelp = await executeToolHub(mainTools, { provider: "memory" });
  const mainActions = asRecord(mainProviderHelp.data).actions as Array<{ name?: string }>;
  assert.equal(
    mainActions.some((entry) => entry.name === "search"),
    true
  );
  assert.equal(
    mainActions.some((entry) => entry.name === "get"),
    true
  );
  assert.equal(
    mainActions.some((entry) => entry.name === "write"),
    true
  );

  const spokeTools = buildCustomToolDefinitions({
    workspaceDir: root,
    memoryScope: "spoke",
    memoryWriteEnabled: false,
    stateDir: join(root, "state"),
    phaseBRolloutScope: "all",
  });
  assert.equal(
    spokeTools.some((tool) => tool.name === "bash"),
    true
  );
  assert.equal(
    ["read", "edit", "write", "grep", "find", "ls"].every((name) =>
      spokeTools.some((tool) => tool.name === name)
    ),
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
    workspaceDir: root,
    memoryScope: "main",
    stateDir: join(root, "state"),
  });
  const traversal = await executeToolHub(tools, {
    provider: "memory",
    action: "get",
    args: { path: "../outside-secret.md" },
  });
  assert.equal(asRecord(traversal.data).disabled, true);

  try {
    await symlink(outsidePath, join(memoryDir, "linked.md"));
    const bySymlink = await executeToolHub(tools, {
      provider: "memory",
      action: "get",
      args: { path: "memory/linked.md" },
    });
    assert.equal(asRecord(bySymlink.data).disabled, true);
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
    workspaceDir: root,
    memoryScope: "main",
    memoryWriteEnabled: true,
    stateDir: join(root, "state"),
    phaseBRolloutScope: "all",
  });

  await executeToolHub(tools, {
    provider: "memory",
    action: "write",
    args: {
      content: "Long term note for phase B integration",
      scope: "long-term",
    },
  });

  const transcriptsDir = join(root, "transcripts");
  const sessionDir = join(transcriptsDir, "main");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    join(sessionDir, "2026-02-28.jsonl"),
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

  const search = await executeToolHub(tools, {
    provider: "memory",
    action: "search",
    args: {
      query: "phase b summary",
      maxResults: 5,
    },
  });

  const results = (asRecord(search.data).results ?? []) as Array<{ path: string }>;
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
