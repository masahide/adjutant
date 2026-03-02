import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCustomToolDefinitions,
  configureSandbox,
} from "../../../src/assistant/agent-session-factory.js";
import { configureWorkerSandboxFromEnv } from "../../../src/agent-worker-acp/sandbox-bootstrap.js";

test("configureWorkerSandboxFromEnv enables sandbox bash for spoke scope", async () => {
  configureSandbox(null);

  const configured = await configureWorkerSandboxFromEnv(
    {
      ACP_WORKER_SANDBOX_MODE: "all",
      ACP_WORKER_SANDBOX_CONTAINER_NAME: "adjutant-sandbox-test",
      ACP_WORKER_SANDBOX_HOST_WORKSPACE_DIR: process.cwd(),
      ACP_WORKER_SANDBOX_WORKDIR: "/workspace",
      ACP_WORKER_SANDBOX_ENV_ALLOWLIST: "LANG,TERM",
    },
    process.cwd()
  );

  const tools = buildCustomToolDefinitions({
    cwd: process.cwd(),
    memoryScope: "spoke",
  });
  assert.equal(configured.enabled, true);
  assert.equal(configured.mode, "all");
  assert.equal(
    tools.some((tool) => tool.name === "bash"),
    true
  );

  configureSandbox(null);
});

test("configureWorkerSandboxFromEnv disables sandbox when mode is off", async () => {
  configureSandbox(null);

  const configured = await configureWorkerSandboxFromEnv(
    {
      ACP_WORKER_SANDBOX_MODE: "off",
    },
    process.cwd()
  );

  const tools = buildCustomToolDefinitions({
    cwd: process.cwd(),
    memoryScope: "spoke",
  });
  assert.equal(configured.enabled, false);
  assert.equal(configured.mode, "off");
  assert.equal(
    tools.some((tool) => tool.name === "bash"),
    false
  );
});

test("configureWorkerSandboxFromEnv disables sandbox when container is missing", async () => {
  configureSandbox(null);

  const configured = await configureWorkerSandboxFromEnv(
    {
      ACP_WORKER_SANDBOX_MODE: "all",
    },
    process.cwd()
  );

  const tools = buildCustomToolDefinitions({
    cwd: process.cwd(),
    memoryScope: "spoke",
  });
  assert.equal(configured.enabled, false);
  assert.equal(configured.mode, "all");
  assert.equal(
    tools.some((tool) => tool.name === "bash"),
    false
  );
});
