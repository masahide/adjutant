import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { afterEach, describe, it, mock } from "node:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  buildDockerExecArgs,
  createDockerBashOperations,
  shouldSandbox,
} from "../../src/sandbox/docker-bash-operations.js";

type FakeChildProcess = ChildProcessWithoutNullStreams & EventEmitter;

function createFakeChildProcess(): FakeChildProcess {
  const child = new EventEmitter() as FakeChildProcess;
  child.stdout = new EventEmitter() as never;
  child.stderr = new EventEmitter() as never;
  child.kill = (() => true) as never;
  return child;
}

describe("docker bash operations", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it("buildDockerExecArgs は bash -lc と -w を組み立てる", () => {
    const args = buildDockerExecArgs({
      containerName: "adjutant-sandbox-a1b2c3",
      containerCwd: "/workspace/src",
      command: "ls -la",
      env: {
        LANG: "C.UTF-8",
      },
    });
    assert.deepEqual(args.slice(0, 4), ["exec", "-i", "-w", "/workspace/src"]);
    assert.equal(args.includes("-e"), true);
    assert.equal(args.includes("LANG=C.UTF-8"), true);
    assert.equal(args[args.length - 3], "bash");
    assert.equal(args[args.length - 2], "-lc");
    assert.equal(args[args.length - 1], "ls -la");
  });

  it("shouldSandbox は mode と memoryScope で判定する", () => {
    assert.equal(shouldSandbox("off", "main"), false);
    assert.equal(shouldSandbox("off", "spoke"), false);
    assert.equal(shouldSandbox("non-main", "main"), false);
    assert.equal(shouldSandbox("non-main", "spoke"), true);
    assert.equal(shouldSandbox("non-main", undefined), true);
    assert.equal(shouldSandbox("all", "main"), true);
    assert.equal(shouldSandbox("all", "spoke"), true);
  });

  it("exec: stdout/stderr を stream し終了コードを返す", async () => {
    const child = createFakeChildProcess();
    const captured: Buffer[] = [];
    const spawnImpl = mock.fn((_command: string, _args: readonly string[]) => {
      setImmediate(() => {
        child.stdout.emit("data", Buffer.from("out\n"));
        child.stderr.emit("data", Buffer.from("err\n"));
        child.emit("close", 0);
      });
      return child;
    });
    const ops = createDockerBashOperations({
      containerName: "adjutant-sandbox-a1b2c3",
      hostWorkspaceDir: "/tmp/workspace",
      containerWorkdir: "/workspace",
      spawnImpl: spawnImpl as never,
    });
    const result = await ops.exec("echo ok", "/tmp/workspace/src", {
      onData: (data) => {
        captured.push(data);
      },
    });
    assert.equal(result.exitCode, 0);
    assert.equal(captured.map((chunk) => chunk.toString()).join(""), "out\nerr\n");
  });

  it("exec: 非0終了コードでも resolve する", async () => {
    const child = createFakeChildProcess();
    const spawnImpl = mock.fn((_command: string, _args: readonly string[]) => {
      setImmediate(() => {
        child.emit("close", 2);
      });
      return child;
    });
    const ops = createDockerBashOperations({
      containerName: "adjutant-sandbox-a1b2c3",
      hostWorkspaceDir: "/tmp/workspace",
      containerWorkdir: "/workspace",
      spawnImpl: spawnImpl as never,
    });
    const result = await ops.exec("exit 2", "/tmp/workspace", {
      onData: () => undefined,
    });
    assert.equal(result.exitCode, 2);
  });

  it("exec: timeout 到達で SIGKILL し timeout エラーを返す", async () => {
    const child = createFakeChildProcess();
    const killMock = mock.fn(() => {
      setImmediate(() => {
        child.emit("close", null);
      });
      return true;
    });
    child.kill = killMock as never;
    const spawnImpl = mock.fn((_command: string, _args: readonly string[]) => child);
    const ops = createDockerBashOperations({
      containerName: "adjutant-sandbox-a1b2c3",
      hostWorkspaceDir: "/tmp/workspace",
      containerWorkdir: "/workspace",
      spawnImpl: spawnImpl as never,
    });
    await assert.rejects(
      ops.exec("sleep 10", "/tmp/workspace", {
        onData: () => undefined,
        timeout: 0.01,
      }),
      /timeout:0.01/
    );
    assert.equal(killMock.mock.calls.length > 0, true);
  });

  it("exec: AbortSignal で SIGKILL し aborted エラーを返す", async () => {
    const child = createFakeChildProcess();
    const killMock = mock.fn(() => {
      setImmediate(() => {
        child.emit("close", null);
      });
      return true;
    });
    child.kill = killMock as never;
    const spawnImpl = mock.fn((_command: string, _args: readonly string[]) => child);
    const ops = createDockerBashOperations({
      containerName: "adjutant-sandbox-a1b2c3",
      hostWorkspaceDir: "/tmp/workspace",
      containerWorkdir: "/workspace",
      spawnImpl: spawnImpl as never,
    });
    const controller = new AbortController();
    const promise = ops.exec("sleep 10", "/tmp/workspace", {
      onData: () => undefined,
      signal: controller.signal,
    });
    controller.abort();
    await assert.rejects(promise, /aborted/);
    assert.equal(killMock.mock.calls.length > 0, true);
  });
});
