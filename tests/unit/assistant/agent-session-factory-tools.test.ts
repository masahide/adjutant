import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCustomToolDefinitions,
  configureSandbox,
} from "../../../src/assistant/agent-session-factory.js";

async function executeToolHub(
  tools: ReturnType<typeof buildCustomToolDefinitions>,
  params?: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const tool = tools.find((entry) => entry.name === "tool_hub");
  assert.ok(tool);
  assert.ok(tool.execute);
  const result = (await tool.execute(
    "tool_hub_call",
    params,
    undefined,
    undefined,
    undefined as never
  )) as { details?: unknown };
  return (result.details ?? {}) as Record<string, unknown>;
}

test("buildCustomToolDefinitions enables tool_hub and memory provider only for main scope", async () => {
  const mainTools = buildCustomToolDefinitions({
    workspaceDir: process.cwd(),
    memoryScope: "main",
  });
  const mainNames = mainTools.map((tool) => tool.name).sort();
  assert.deepEqual(mainNames, ["tool_hub"]);
  const mainCatalog = await executeToolHub(mainTools);
  assert.deepEqual(mainCatalog, {
    ok: true,
    mode: "catalog",
    data: {
      providers: [
        {
          name: "slack",
          description: "Resolve Slack thread/message context via play-slack-search.",
        },
        {
          name: "memory",
          description: "Read and write assistant memory files.",
        },
      ],
      usage: "set provider to get actions",
    },
  });

  const spokeTools = buildCustomToolDefinitions({
    workspaceDir: process.cwd(),
    memoryScope: "spoke",
  });
  assert.deepEqual(
    spokeTools.map((tool) => tool.name),
    ["tool_hub"]
  );
  const spokeCatalog = await executeToolHub(spokeTools);
  assert.deepEqual(spokeCatalog, {
    ok: true,
    mode: "catalog",
    data: {
      providers: [
        {
          name: "slack",
          description: "Resolve Slack thread/message context via play-slack-search.",
        },
      ],
      usage: "set provider to get actions",
    },
  });
});

test("buildCustomToolDefinitions enables memory write action only when memoryWriteEnabled is true", async () => {
  const enabled = buildCustomToolDefinitions({
    workspaceDir: process.cwd(),
    memoryScope: "spoke",
    memoryWriteEnabled: true,
    phaseBRolloutScope: "all",
  });
  const enabledProviderHelp = await executeToolHub(enabled, { provider: "memory" });
  assert.deepEqual(enabledProviderHelp, {
    ok: true,
    mode: "provider_help",
    provider: "memory",
    data: {
      actions: [
        {
          name: "write",
          description: "Persist notable context into assistant memory files.",
          requiredArgs: ["content"],
          argsSchema: {
            type: "object",
            properties: {
              content: { type: "string", minLength: 1 },
              scope: { enum: ["daily", "long-term"] },
            },
            required: ["content"],
            additionalProperties: false,
          },
        },
      ],
    },
  });

  const disabled = buildCustomToolDefinitions({
    workspaceDir: process.cwd(),
    memoryScope: "spoke",
    memoryWriteEnabled: false,
  });
  await assert.rejects(() => executeToolHub(disabled, { provider: "memory" }), /unknown provider/);
});

test("buildCustomToolDefinitions defaults phase B rollout to main-only", async () => {
  const spokeTools = buildCustomToolDefinitions({
    workspaceDir: process.cwd(),
    memoryScope: "spoke",
    memoryWriteEnabled: true,
    phaseBRolloutScope: "main",
  });
  assert.equal(
    spokeTools.some((tool) => tool.name === "tool_hub"),
    true
  );
  await assert.rejects(
    () => executeToolHub(spokeTools, { provider: "memory" }),
    /unknown provider/
  );
});

test("buildCustomToolDefinitions enables sandboxed bash by mode and memoryScope", () => {
  configureSandbox({
    mode: "non-main",
    runSpec: {
      image: "adjutant-sandbox:test",
      hostWorkspaceDir: process.cwd(),
      containerWorkdir: "/workspace",
      containerHome: "/home/agent",
      user: "1000:1000",
      envAllowlist: ["LANG"],
    },
  });

  const mainTools = buildCustomToolDefinitions({
    workspaceDir: process.cwd(),
    memoryScope: "main",
  });
  assert.equal(
    mainTools.some((tool) => tool.name === "bash"),
    false
  );
  assert.equal(
    mainTools.some((tool) => tool.name === "read"),
    false
  );

  const spokeTools = buildCustomToolDefinitions({
    workspaceDir: process.cwd(),
    memoryScope: "spoke",
    phaseBRolloutScope: "main",
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

  configureSandbox(null);
});

test("buildCustomToolDefinitions excludes tool_hub from heartbeat sessions", () => {
  const tools = buildCustomToolDefinitions({
    workspaceDir: process.cwd(),
    memoryScope: "main",
    isHeartbeat: true,
  });

  assert.equal(
    tools.some((tool) => tool.name === "tool_hub"),
    false
  );
  assert.equal(tools.length, 0);
});
