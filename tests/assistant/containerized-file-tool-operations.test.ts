import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, it, mock } from "node:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createContainerizedFileTools } from "../../src/assistant/containerized-file-tool-operations.js";

type FakeChildProcess = ChildProcessWithoutNullStreams & EventEmitter;

function createFakeChild(params: {
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
}): FakeChildProcess {
  const child = new EventEmitter() as FakeChildProcess;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  child.stdin = stdin as never;
  child.stdout = stdout as never;
  child.stderr = stderr as never;
  child.kill = (() => true) as never;

  setImmediate(() => {
    if (params.stdout) {
      stdout.write(params.stdout);
    }
    if (params.stderr) {
      stderr.write(params.stderr);
    }
    stdout.end();
    stderr.end();
    child.emit("close", params.exitCode);
  });
  return child;
}

describe("containerized file tool operations", () => {
  it("read/write/edit/grep/find/ls の6ツールを提供する", () => {
    const tools = createContainerizedFileTools({
      containerName: "sandbox-test",
      containerWorkdir: "/workspace",
    });
    const names = tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, ["edit", "find", "grep", "ls", "read", "write"]);
  });

  it("read は docker exec 経由で実行される", async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const spawnImpl = mock.fn((command: string, args: readonly string[], _options: unknown) => {
      calls.push({ command, args });
      const script = String(args[args.length - 1] ?? "");
      if (script === '[ -r "$ADJ_PATH" ]') {
        return createFakeChild({ exitCode: 0 });
      }
      if (script === 'cat -- "$ADJ_PATH"') {
        return createFakeChild({ exitCode: 0, stdout: "hello-from-container\n" });
      }
      return createFakeChild({ exitCode: 1, stderr: "unexpected command" });
    });

    const tools = createContainerizedFileTools({
      containerName: "sandbox-test",
      containerWorkdir: "/workspace",
      spawnImpl: spawnImpl as never,
    });
    const read = tools.find((tool) => tool.name === "read");
    assert.ok(read);
    if (!read) {
      return;
    }

    const executeRead = read.execute as (...args: unknown[]) => Promise<unknown>;
    const result = (await executeRead("tool-read", {
      path: "sample.txt",
    })) as { content?: Array<{ type: string; text?: string }> };
    const text = result.content?.[0]?.text ?? "";
    assert.match(text, /hello-from-container/);
    assert.equal(calls.length >= 2, true);
    for (const call of calls) {
      assert.equal(call.command, "docker");
      assert.equal(call.args[0], "exec");
      assert.equal(call.args.includes("sandbox-test"), true);
    }
  });

  it("grep は docker exec 経由で実行され、結果0件を返せる", async () => {
    const spawnImpl = mock.fn((_command: string, args: readonly string[], _options: unknown) => {
      const script = String(args[args.length - 1] ?? "");
      if (script === '[ -e "$ADJ_PATH" ]') {
        return createFakeChild({ exitCode: 0 });
      }
      if (script === '[ -d "$ADJ_PATH" ]') {
        return createFakeChild({ exitCode: 0 });
      }
      if (script.includes("--json")) {
        return createFakeChild({ exitCode: 1 });
      }
      return createFakeChild({ exitCode: 1, stderr: "unexpected command" });
    });

    const tools = createContainerizedFileTools({
      containerName: "sandbox-test",
      containerWorkdir: "/workspace",
      spawnImpl: spawnImpl as never,
    });
    const grep = tools.find((tool) => tool.name === "grep");
    assert.ok(grep);
    if (!grep) {
      return;
    }

    const executeGrep = grep.execute as (...args: unknown[]) => Promise<unknown>;
    const result = (await executeGrep("tool-grep", {
      pattern: "TODO",
      path: "/workspace/src",
    })) as { content?: Array<{ type: string; text?: string }> };
    assert.equal(result.content?.[0]?.type, "text");
    assert.equal(result.content?.[0]?.text, "No matches found");
  });
});
