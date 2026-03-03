import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCustomToolDefinitions,
  configureSandbox,
} from "../../../src/assistant/agent-session-factory.js";

test("buildCustomToolDefinitions enables memory tools only for main scope", () => {
  const mainTools = buildCustomToolDefinitions({
    cwd: process.cwd(),
    memoryScope: "main",
  });
  const mainNames = mainTools.map((tool) => tool.name).sort();
  assert.deepEqual(mainNames, ["memory_get", "memory_search"]);

  const spokeTools = buildCustomToolDefinitions({
    cwd: process.cwd(),
    memoryScope: "spoke",
  });
  assert.equal(spokeTools.length, 0);
});

test("buildCustomToolDefinitions enables memory_write only when memoryWriteEnabled is true", () => {
  const enabled = buildCustomToolDefinitions({
    cwd: process.cwd(),
    memoryScope: "spoke",
    memoryWriteEnabled: true,
    phaseBRolloutScope: "all",
  });
  assert.equal(
    enabled.some((tool) => tool.name === "memory_write"),
    true
  );

  const disabled = buildCustomToolDefinitions({
    cwd: process.cwd(),
    memoryScope: "spoke",
    memoryWriteEnabled: false,
  });
  assert.equal(
    disabled.some((tool) => tool.name === "memory_write"),
    false
  );
});

test("buildCustomToolDefinitions defaults phase B rollout to main-only", () => {
  const spokeTools = buildCustomToolDefinitions({
    cwd: process.cwd(),
    memoryScope: "spoke",
    memoryWriteEnabled: true,
    phaseBRolloutScope: "main",
  });
  assert.equal(
    spokeTools.some((tool) => tool.name === "memory_write"),
    false
  );
});

test("buildCustomToolDefinitions enables sandboxed bash by mode and memoryScope", () => {
  configureSandbox({
    mode: "non-main",
    runSpec: {
      image: "adjutant-sandbox:test",
      hostWorkspaceDir: process.cwd(),
      containerWorkdir: "/workspace",
      envAllowlist: ["LANG"],
    },
  });

  const mainTools = buildCustomToolDefinitions({
    cwd: process.cwd(),
    memoryScope: "main",
  });
  assert.equal(
    mainTools.some((tool) => tool.name === "bash"),
    false
  );

  const spokeTools = buildCustomToolDefinitions({
    cwd: process.cwd(),
    memoryScope: "spoke",
    phaseBRolloutScope: "main",
  });
  assert.equal(
    spokeTools.some((tool) => tool.name === "bash"),
    true
  );

  configureSandbox(null);
});
