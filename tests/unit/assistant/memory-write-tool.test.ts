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
    workspaceDir,
    memoryScope: "main",
    memoryWriteEnabled: true,
  });
  const toolHub = tools.find((tool) => tool.name === "tool_hub");
  assert.ok(toolHub);

  const dailyResult = (await toolHub.execute(
    "call_1",
    {
      provider: "memory",
      action: "write",
      args: { content: "daily fact", scope: "daily" },
    },
    undefined,
    undefined,
    undefined as never
  )) as ToolResult;
  const dailyDetails = asRecord(dailyResult.details);
  const dailyData = asRecord(dailyDetails.data);
  const dailyPath = String(dailyData.path ?? "");
  assert.equal(dailyPath.startsWith("memory/"), true);

  const longTermResult = (await toolHub.execute(
    "call_2",
    {
      provider: "memory",
      action: "write",
      args: { content: "long term fact", scope: "long-term" },
    },
    undefined,
    undefined,
    undefined as never
  )) as ToolResult;
  const longTermDetails = asRecord(longTermResult.details);
  const longTermData = asRecord(longTermDetails.data);
  assert.equal(longTermData.path, "MEMORY.md");

  const dailyContent = await readFile(join(workspaceDir, dailyPath), "utf8");
  assert.equal(dailyContent.includes("daily fact"), true);

  const longTermContent = await readFile(join(workspaceDir, "MEMORY.md"), "utf8");
  assert.equal(longTermContent.includes("long term fact"), true);
});
