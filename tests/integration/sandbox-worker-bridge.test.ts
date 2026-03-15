import assert from "node:assert/strict";
import test from "node:test";

import {
  configureSandbox,
  getConfiguredSandbox,
} from "../../src/assistant/agent-session-factory.js";
import { configureWorkerSandboxFromEnv } from "../../src/agent-worker-acp/sandbox-bootstrap.js";
import { resolveSandboxConfig } from "../../src/sandbox/config.js";
import { buildDockerRunArgs } from "../../src/sandbox/docker-bash-operations.js";
import { applySandboxToWorkerEnv } from "../../src/sandbox/worker-env-bridge.js";

test("sandbox worker env bridge preserves image, home, and user across bootstrap boundaries", async () => {
  configureSandbox(null);
  const cwd = process.cwd();
  const config = resolveSandboxConfig({
    ADJUTANT_SANDBOX_MODE: "all",
    ADJUTANT_SANDBOX_IMAGE: "custom-sandbox:integration",
    ADJUTANT_SANDBOX_HOME: "/home/integration-agent",
    ADJUTANT_SANDBOX_USER: "501:20",
    ADJUTANT_SANDBOX_ENV_ALLOWLIST: "LANG,TERM",
    ADJUTANT_SANDBOX_PIDS_LIMIT: "64",
    ADJUTANT_SANDBOX_MEMORY: "512m",
  } as NodeJS.ProcessEnv);

  const workerEnv = applySandboxToWorkerEnv({} as NodeJS.ProcessEnv, {
    enabled: true,
    mode: config.mode,
    runSpec: {
      image: config.docker.image,
      hostWorkspaceDir: cwd,
      containerWorkdir: config.docker.workdir,
      containerHome: config.docker.home,
      user: config.docker.user,
      envAllowlist: config.docker.envAllowlist,
      readOnlyRoot: config.docker.readOnlyRoot,
      tmpfs: config.docker.tmpfs,
      network: config.docker.network,
      capDrop: config.docker.capDrop,
      pidsLimit: config.docker.pidsLimit,
      memory: config.docker.memory,
    },
  });

  const configured = await configureWorkerSandboxFromEnv(workerEnv, cwd);
  assert.equal(configured.enabled, true);
  assert.equal(configured.mode, "all");

  const runSpec = getConfiguredSandbox()?.runSpec;
  assert.equal(runSpec?.image, "custom-sandbox:integration");
  assert.equal(runSpec?.containerHome, "/home/integration-agent");
  assert.equal(runSpec?.user, "501:20");

  const args = buildDockerRunArgs({
    runSpec: runSpec!,
    containerCwd: "/workspace",
    command: "pwd",
  });
  assert.equal(args.includes("custom-sandbox:integration"), true);
  assert.equal(args.includes("HOME=/home/integration-agent"), true);
  assert.equal(args.includes("501:20"), true);

  configureSandbox(null);
});
