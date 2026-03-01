import assert from "node:assert/strict";
import test from "node:test";

import { buildDockerExecArgs, shouldSandbox } from "../../../src/sandbox/docker-bash-operations.js";

test("shouldSandbox respects off/non-main/all modes", () => {
  assert.equal(shouldSandbox("off", "main"), false);
  assert.equal(shouldSandbox("off", "spoke"), false);
  assert.equal(shouldSandbox("non-main", "main"), false);
  assert.equal(shouldSandbox("non-main", "spoke"), true);
  assert.equal(shouldSandbox("all", "main"), true);
  assert.equal(shouldSandbox("all", "spoke"), true);
});

test("buildDockerExecArgs keeps only allowlisted env vars", () => {
  const args = buildDockerExecArgs({
    containerName: "sandbox-x",
    containerCwd: "/workspace",
    command: "echo hello",
    env: {
      LANG: "ja_JP.UTF-8",
      OPENAI_API_KEY: "secret",
    },
    envAllowlist: ["LANG"],
  });

  assert.deepEqual(args.slice(0, 4), ["exec", "-i", "-w", "/workspace"]);
  assert.equal(args.includes("-e"), true);
  assert.equal(args.includes("LANG=ja_JP.UTF-8"), true);
  assert.equal(args.includes("OPENAI_API_KEY=secret"), false);
});
