import assert from "node:assert/strict";
import test from "node:test";

import { initializeSandboxRuntime } from "../../../src/sandbox/runtime.js";
import type { DockerCommandResult, DockerCommandRunner } from "../../../src/sandbox/docker.js";

function createRunner(
  impl: (args: string[], options?: { allowFailure?: boolean }) => DockerCommandResult
): DockerCommandRunner {
  return async (args, options) => impl(args, options);
}

test("initializeSandboxRuntime keeps sandbox disabled when mode=off", async () => {
  const calls: string[][] = [];
  const runner = createRunner((args) => {
    calls.push(args);
    return { code: 0, stdout: "", stderr: "" };
  });

  const runtime = await initializeSandboxRuntime({
    workspaceDir: process.cwd(),
    env: {
      ...process.env,
      ADJUTANT_SANDBOX_MODE: "off",
    },
    runner,
  });

  assert.equal(runtime.enabled, false);
  assert.equal(runtime.mode, "off");
  assert.equal(calls.length, 0);
  await runtime.dispose();
});

test("initializeSandboxRuntime fails closed when docker is unavailable under default mode", async () => {
  const runner = createRunner((args) => {
    if (args[0] === "version") {
      return { code: 1, stdout: "", stderr: "daemon not running" };
    }
    return { code: 0, stdout: "", stderr: "" };
  });

  await assert.rejects(
    async () =>
      await initializeSandboxRuntime({
        workspaceDir: process.cwd(),
        env: {},
        runner,
      }),
    /sandbox unavailable/
  );
});

test("initializeSandboxRuntime prepares per-tool runSpec without creating containers", async () => {
  const calls: string[][] = [];
  const runner = createRunner((args) => {
    calls.push(args);
    if (args[0] === "version") {
      return { code: 0, stdout: "25.0", stderr: "" };
    }
    if (args[0] === "image" && args[1] === "inspect") {
      return { code: 0, stdout: "ok", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  });

  const runtime = await initializeSandboxRuntime({
    workspaceDir: process.cwd(),
    env: {
      ...process.env,
      ADJUTANT_SANDBOX_MODE: "all",
      ADJUTANT_SANDBOX_AUTO_BUILD_IMAGE: "0",
      ADJUTANT_SANDBOX_IMAGE: "adjutant-sandbox:test",
      ADJUTANT_SANDBOX_WORKDIR: "/workspace",
      ADJUTANT_SANDBOX_HOME: "/home/runtime-agent",
      ADJUTANT_SANDBOX_USER: "1234:5678",
      ADJUTANT_SANDBOX_NETWORK: "none",
      ADJUTANT_SANDBOX_PIDS_LIMIT: "128",
      ADJUTANT_SANDBOX_MEMORY: "1g",
    },
    runner,
  });

  assert.equal(runtime.enabled, true);
  assert.equal(runtime.mode, "all");
  assert.equal(runtime.runSpec?.image, "adjutant-sandbox:test");
  assert.equal(runtime.runSpec?.containerWorkdir, "/workspace");
  assert.equal(runtime.runSpec?.containerHome, "/home/runtime-agent");
  assert.equal(runtime.runSpec?.user, "1234:5678");
  assert.equal(runtime.runSpec?.network, "none");
  assert.equal(runtime.runSpec?.pidsLimit, 128);
  assert.equal(runtime.runSpec?.memory, "1g");
  assert.equal(
    runtime.runSpec?.tmpfs?.includes(
      "/home/runtime-agent:rw,exec,nosuid,size=512m,uid=1234,gid=5678,mode=700"
    ),
    true
  );

  await runtime.dispose();
  assert.equal(
    calls.some((args) => args[0] === "create" || args[0] === "start" || args[0] === "rm"),
    false
  );
});
