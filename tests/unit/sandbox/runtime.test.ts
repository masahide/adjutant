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

test("initializeSandboxRuntime fails closed when docker is unavailable", async () => {
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
        env: {
          ...process.env,
          ADJUTANT_SANDBOX_MODE: "non-main",
        },
        runner,
      }),
    /sandbox unavailable/
  );
});

test("initializeSandboxRuntime provisions and disposes sandbox container", async () => {
  const calls: string[][] = [];
  let inspectCount = 0;
  const runner = createRunner((args) => {
    calls.push(args);
    if (args[0] === "version") {
      return { code: 0, stdout: "25.0", stderr: "" };
    }
    if (args[0] === "image" && args[1] === "inspect") {
      return { code: 0, stdout: "ok", stderr: "" };
    }
    if (args[0] === "inspect" && args[1] === "--type" && args[2] === "container") {
      inspectCount += 1;
      if (inspectCount === 1) {
        return { code: 1, stdout: "", stderr: "No such object" };
      }
      return {
        code: 0,
        stdout:
          '[{"Config":{"Labels":{"adjutant.sandbox.owner":"nonce-test"}},"State":{"Running":true}}]',
        stderr: "",
      };
    }
    return { code: 0, stdout: "", stderr: "" };
  });

  const runtime = await initializeSandboxRuntime({
    workspaceDir: process.cwd(),
    env: {
      ...process.env,
      ADJUTANT_SANDBOX_MODE: "all",
      ADJUTANT_SANDBOX_AUTO_BUILD_IMAGE: "0",
    },
    ownerNonce: "nonce-test",
    runner,
  });

  assert.equal(runtime.enabled, true);
  assert.equal(runtime.mode, "all");
  assert.equal(typeof runtime.containerName, "string");

  await runtime.dispose();
  assert.equal(
    calls.some((args) => args[0] === "create"),
    true
  );
  assert.equal(
    calls.some((args) => args[0] === "start"),
    true
  );
  assert.equal(
    calls.some((args) => args[0] === "rm" && args[1] === "-f"),
    true
  );
});
