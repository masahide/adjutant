import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveMemorySearchRuntimeConfig } from "../../../src/assistant/memory/config.js";
import { createMemoryToolDefinitions } from "../../../src/assistant/memory/tool-definitions.js";
import { clearMemorySqliteIndexCacheForTest } from "../../../src/assistant/memory/sqlite-index.js";

interface ToolResult {
  details?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return {};
  }
  return value as Record<string, unknown>;
}

async function executeTool(tool: any, params: unknown) {
  return (await tool.execute("call_test", params, undefined, undefined, undefined)) as ToolResult;
}

test("createMemoryToolDefinitions exposes memory_search and memory_get", async (t) => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "adjutant-memory-tools-"));
  const stateDir = join(workspaceDir, ".state");
  const dbPath = join(stateDir, "memory", "main.sqlite");
  t.after(async () => {
    clearMemorySqliteIndexCacheForTest();
    await rm(workspaceDir, { recursive: true, force: true });
  });

  await mkdir(join(workspaceDir, "memory"), { recursive: true });
  await writeFile(join(workspaceDir, "MEMORY.md"), "alpha memory\n", "utf8");
  await writeFile(join(workspaceDir, "memory", "daily.md"), "beta hello memory\n", "utf8");

  const config = resolveMemorySearchRuntimeConfig({
    env: {
      ...process.env,
      ADJUTANT_MEMORY_SEARCH_ENABLED: "1",
      ADJUTANT_MEMORY_SEARCH_DB_PATH: dbPath,
    },
    stateDir,
    agentId: "main",
  });
  const tools = createMemoryToolDefinitions({
    workspaceDir,
    config,
  });
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["memory_search", "memory_get"]
  );

  const searchTool = tools[0];
  assert.ok(searchTool);
  const searchResult = await executeTool(searchTool, {
    query: "hello",
  });
  const searchPayload = asRecord(searchResult.details);
  const results = Array.isArray(searchPayload.results) ? searchPayload.results : [];
  assert.equal(results.length > 0, true);

  const getTool = tools[1];
  assert.ok(getTool);
  const getResult = await executeTool(getTool, {
    path: "memory/daily.md",
    from: 1,
    lines: 1,
  });
  const getPayload = asRecord(getResult.details);
  assert.equal(getPayload.path, "memory/daily.md");
  assert.equal(typeof getPayload.text, "string");

  await access(dbPath);
});

test("memory_get returns disabled payload for disallowed path", async (t) => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "adjutant-memory-get-"));
  const stateDir = join(workspaceDir, ".state");
  t.after(async () => {
    clearMemorySqliteIndexCacheForTest();
    await rm(workspaceDir, { recursive: true, force: true });
  });

  await mkdir(join(workspaceDir, "memory"), { recursive: true });
  await writeFile(join(workspaceDir, "memory", "daily.md"), "daily\n", "utf8");

  const tools = createMemoryToolDefinitions({
    workspaceDir,
    config: resolveMemorySearchRuntimeConfig({
      env: {
        ...process.env,
        ADJUTANT_MEMORY_SEARCH_ENABLED: "1",
        ADJUTANT_MEMORY_SEARCH_DB_PATH: join(stateDir, "memory", "main.sqlite"),
      },
      stateDir,
      agentId: "main",
    }),
  });
  const getTool = tools.find((tool) => tool.name === "memory_get");
  assert.ok(getTool);

  const failed = await executeTool(getTool, {
    path: "../outside.md",
  });
  const payload = asRecord(failed.details);
  assert.equal(payload.disabled, true);
  assert.equal(payload.path, "../outside.md");
});
