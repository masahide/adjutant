import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { EventEmitter } from "node:events";

import {
  buildDockerRunArgs,
  createDockerBashOperations,
  shouldSandbox,
} from "../../../src/sandbox/docker-bash-operations.js";

function createMockSpawn(params?: { autoCloseMs?: number }) {
  const calls: Array<{ command: string; args: string[] }> = [];

  const spawnImpl = (command: string, args: readonly string[]) => {
    calls.push({ command, args: [...args] });

    const child = new EventEmitter() as unknown as {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: (_signal?: NodeJS.Signals) => boolean;
      on: (event: string, listener: (...values: unknown[]) => void) => unknown;
      emit: (event: string, ...values: unknown[]) => boolean;
    };

    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = (_signal?: NodeJS.Signals) => {
      setImmediate(() => {
        child.emit("close", null);
      });
      return true;
    };

    const autoCloseMs = params?.autoCloseMs;
    if (typeof autoCloseMs === "number" && autoCloseMs >= 0) {
      setTimeout(() => {
        child.emit("close", 0);
      }, autoCloseMs);
    }

    return child as never;
  };

  return {
    calls,
    spawnImpl,
  };
}

test("shouldSandbox respects off/non-main/all modes", () => {
  assert.equal(shouldSandbox("off", "main"), false);
  assert.equal(shouldSandbox("off", "spoke"), false);
  assert.equal(shouldSandbox("non-main", "main"), false);
  assert.equal(shouldSandbox("non-main", "spoke"), true);
  assert.equal(shouldSandbox("all", "main"), true);
  assert.equal(shouldSandbox("all", "spoke"), true);
});

test("buildDockerRunArgs builds docker run --rm and keeps only allowlisted env vars", () => {
  const args = buildDockerRunArgs({
    runSpec: {
      image: "adjutant-sandbox:test",
      hostWorkspaceDir: process.cwd(),
      containerWorkdir: "/workspace",
      containerHome: "/home/agent",
      user: "2001:3001",
      envAllowlist: ["LANG"],
      network: "none",
      pidsLimit: 128,
      memory: "1g",
    },
    containerCwd: "/workspace",
    command: "echo hello",
    env: {
      LANG: "ja_JP.UTF-8",
      OPENAI_API_KEY: "secret",
    },
  });

  assert.deepEqual(args.slice(0, 7), [
    "run",
    "--rm",
    "-i",
    "--pull=never",
    "--init",
    "--workdir",
    "/workspace",
  ]);
  assert.equal(args.includes("--read-only"), true);
  assert.equal(args.includes("--user"), true);
  assert.equal(args.includes("2001:3001"), true);
  assert.equal(args.includes("HOME=/home/agent"), true);
  assert.equal(args.includes("--mount"), true);
  assert.equal(args.includes(`type=bind,src=${process.cwd()},dst=/workspace`), true);
  assert.equal(args.includes("--security-opt"), true);
  assert.equal(args.includes("no-new-privileges=true"), true);
  assert.equal(args.includes("seccomp=builtin"), true);
  assert.equal(args.includes("--ipc=private"), true);
  assert.equal(args.includes("--cgroupns=private"), true);
  assert.equal(args.includes("--hostname=sandbox"), true);
  assert.equal(args.includes("--network"), true);
  assert.equal(args.includes("none"), true);
  assert.equal(args.includes("--memory-swap"), true);
  assert.equal(args.includes("LANG=ja_JP.UTF-8"), true);
  assert.equal(args.includes("OPENAI_API_KEY=secret"), false);
  assert.equal(args.includes("adjutant-sandbox:test"), true);
});

test("createDockerBashOperations.exec aborts active docker run", async () => {
  const mock = createMockSpawn();
  const operations = createDockerBashOperations({
    runSpec: {
      image: "adjutant-sandbox:test",
      hostWorkspaceDir: process.cwd(),
      containerWorkdir: "/workspace",
      containerHome: "/home/agent",
      user: "1000:1000",
    },
    spawnImpl: mock.spawnImpl as never,
  });

  const controller = new AbortController();
  const promise = operations.exec("sleep 10", process.cwd(), {
    env: {},
    timeout: 5,
    signal: controller.signal,
    onData: () => {},
  });

  setTimeout(() => {
    controller.abort();
  }, 20);

  await assert.rejects(async () => await promise, /aborted/);
  assert.equal(mock.calls.length, 1);
  assert.equal(mock.calls[0]?.command, "docker");
});

test("createDockerBashOperations.exec times out and fails", async () => {
  const mock = createMockSpawn();
  const operations = createDockerBashOperations({
    runSpec: {
      image: "adjutant-sandbox:test",
      hostWorkspaceDir: process.cwd(),
      containerWorkdir: "/workspace",
      containerHome: "/home/agent",
      user: "1000:1000",
    },
    spawnImpl: mock.spawnImpl as never,
  });

  await assert.rejects(
    async () =>
      await operations.exec("sleep 10", process.cwd(), {
        env: {},
        timeout: 0.01,
        onData: () => {},
      }),
    /timeout:0.01/
  );
});
