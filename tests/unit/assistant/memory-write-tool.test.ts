import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildCustomToolDefinitions } from "../../../src/assistant/agent-session-factory.js";

interface ToolResult {
  details?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return {};
  }
  return value as Record<string, unknown>;
}

test("memory_write tool writes to daily and long-term markdown", async (t) => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "adjutant-memory-write-"));
  t.after(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });
  await mkdir(join(workspaceDir, "memory"), { recursive: true });

  const tools = buildCustomToolDefinitions({
    cwd: workspaceDir,
    memoryScope: "main",
    memoryWriteEnabled: true,
  });
  const memoryWrite = tools.find((tool) => tool.name === "memory_write");
  assert.ok(memoryWrite);

  const dailyResult = (await memoryWrite.execute(
    "call_1",
    { content: "daily fact", scope: "daily" },
    undefined,
    undefined,
    undefined as never
  )) as ToolResult;
  const dailyDetails = asRecord(dailyResult.details);
  const dailyPath = String(dailyDetails.path ?? "");
  assert.equal(dailyPath.startsWith("memory/"), true);

  const longTermResult = (await memoryWrite.execute(
    "call_2",
    { content: "long term fact", scope: "long-term" },
    undefined,
    undefined,
    undefined as never
  )) as ToolResult;
  const longTermDetails = asRecord(longTermResult.details);
  assert.equal(longTermDetails.path, "MEMORY.md");

  const dailyContent = await readFile(join(workspaceDir, dailyPath), "utf8");
  assert.equal(dailyContent.includes("daily fact"), true);

  const longTermContent = await readFile(join(workspaceDir, "MEMORY.md"), "utf8");
  assert.equal(longTermContent.includes("long term fact"), true);
});
