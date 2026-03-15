import assert from "node:assert/strict";
import test from "node:test";

import {
  configureSandbox,
  getConfiguredSandbox,
} from "../../../src/assistant/agent-session-factory.js";
import { configureWorkerSandboxFromEnv } from "../../../src/agent-worker-acp/sandbox-bootstrap.js";
import { resolveSandboxConfig } from "../../../src/sandbox/config.js";
import { buildDockerRunArgs } from "../../../src/sandbox/docker-bash-operations.js";
import { applySandboxToWorkerEnv } from "../../../src/sandbox/worker-env-bridge.js";

test("applySandboxToWorkerEnv propagates sandbox image through config, worker bootstrap, and docker args", async () => {
  configureSandbox(null);
  const cwd = process.cwd();
  const config = resolveSandboxConfig({
    ADJUTANT_SANDBOX_MODE: "all",
    ADJUTANT_SANDBOX_IMAGE: "custom-sandbox:node22",
    ADJUTANT_SANDBOX_HOME: "/home/dev",
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

  assert.equal(workerEnv.ACP_WORKER_SANDBOX_IMAGE, "custom-sandbox:node22");
  assert.equal(workerEnv.ACP_WORKER_SANDBOX_HOME, "/home/dev");
  assert.equal(workerEnv.ACP_WORKER_SANDBOX_USER, "501:20");
  assert.equal(workerEnv.ACP_WORKER_SANDBOX_TMPFS, JSON.stringify(config.docker.tmpfs));

  const configured = await configureWorkerSandboxFromEnv(workerEnv, cwd);
  assert.equal(configured.enabled, true);
  assert.equal(configured.mode, "all");

  const runSpec = getConfiguredSandbox()?.runSpec;
  assert.equal(runSpec?.image, "custom-sandbox:node22");
  assert.equal(runSpec?.containerHome, "/home/dev");
  assert.equal(runSpec?.user, "501:20");
  assert.deepEqual(runSpec?.tmpfs, config.docker.tmpfs);

  const args = buildDockerRunArgs({
    runSpec: runSpec!,
    containerCwd: "/workspace",
    command: "pwd",
  });
  assert.equal(args.includes("custom-sandbox:node22"), true);
  assert.equal(args.includes("HOME=/home/dev"), true);
  assert.equal(args.includes("501:20"), true);
  assert.equal(args.includes(config.docker.tmpfs[0]!), true);
  assert.equal(args.includes(config.docker.tmpfs[2]!), true);

  configureSandbox(null);
});

test("applySandboxToWorkerEnv clears stale worker sandbox variables when disabled", () => {
  const workerEnv = applySandboxToWorkerEnv(
    {
      ACP_WORKER_SANDBOX_MODE: "all",
      ACP_WORKER_SANDBOX_IMAGE: "stale:image",
      ACP_WORKER_SANDBOX_HOME: "/home/stale",
      ACP_WORKER_SANDBOX_USER: "999:999",
    } as NodeJS.ProcessEnv,
    {
      enabled: false,
      mode: "all",
    }
  );

  assert.equal(workerEnv.ACP_WORKER_SANDBOX_MODE, "off");
  assert.equal(workerEnv.ACP_WORKER_SANDBOX_IMAGE, undefined);
  assert.equal(workerEnv.ACP_WORKER_SANDBOX_HOME, undefined);
  assert.equal(workerEnv.ACP_WORKER_SANDBOX_USER, undefined);
});
