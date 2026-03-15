import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import {
  createContainerizedFileTools,
  getWorkspacePathNotAllowedMessage,
} from "../../../src/assistant/containerized-file-tool-operations.js";

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

test("createContainerizedFileTools provides read/write/edit/grep/find/ls", () => {
  const tools = createContainerizedFileTools({
    runSpec: {
      image: "adjutant-sandbox:test",
      hostWorkspaceDir: process.cwd(),
      containerWorkdir: "/workspace",
      containerHome: "/home/agent",
      user: "1000:1000",
    },
  });
  const names = tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, ["edit", "find", "grep", "ls", "read", "write"]);
});

test("read executes through docker run with mounted workspace", async () => {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const spawnImpl = (command: string, args: readonly string[], _options: unknown) => {
    calls.push({ command, args });
    const script = String(args[args.length - 1] ?? "");
    if (script === '[ -r "$ADJ_PATH" ]') {
      return createFakeChild({ exitCode: 0 });
    }
    if (script === 'cat -- "$ADJ_PATH"') {
      return createFakeChild({ exitCode: 0, stdout: "hello-from-container\n" });
    }
    return createFakeChild({ exitCode: 1, stderr: "unexpected command" });
  };

  const tools = createContainerizedFileTools({
    runSpec: {
      image: "adjutant-sandbox:test",
      hostWorkspaceDir: process.cwd(),
      containerWorkdir: "/workspace",
      containerHome: "/home/agent",
      user: "1000:1000",
    },
    spawnImpl: spawnImpl as never,
  });
  const read = tools.find((tool) => tool.name === "read");
  assert.ok(read);
  if (!read) {
    return;
  }

  const result = await read.execute!(
    "tool-read",
    {
      path: "sample.txt",
    },
    undefined,
    undefined,
    undefined as never
  );
  const text = result.content?.[0]?.type === "text" ? result.content[0].text : "";
  assert.match(text, /hello-from-container/);
  assert.equal(calls.length >= 2, true);
  for (const call of calls) {
    assert.equal(call.command, "docker");
    assert.equal(call.args[0], "run");
    assert.equal(call.args.includes("adjutant-sandbox:test"), true);
    assert.equal(call.args.includes("--mount"), true);
  }
});

test("grep executes through docker run and can return zero matches", async () => {
  const spawnImpl = (_command: string, args: readonly string[], _options: unknown) => {
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
  };

  const tools = createContainerizedFileTools({
    runSpec: {
      image: "adjutant-sandbox:test",
      hostWorkspaceDir: process.cwd(),
      containerWorkdir: "/workspace",
      containerHome: "/home/agent",
      user: "1000:1000",
    },
    spawnImpl: spawnImpl as never,
  });
  const grep = tools.find((tool) => tool.name === "grep");
  assert.ok(grep);
  if (!grep) {
    return;
  }

  const result = await grep.execute!(
    "tool-grep",
    {
      pattern: "TODO",
      path: process.cwd(),
    },
    undefined,
    undefined,
    undefined as never
  );
  assert.equal(result.content?.[0]?.type, "text");
  assert.equal(
    result.content?.[0]?.type === "text" ? result.content[0].text : "",
    "No matches found"
  );
});

test("read rejects workspace outside paths", async () => {
  const tools = createContainerizedFileTools({
    runSpec: {
      image: "adjutant-sandbox:test",
      hostWorkspaceDir: process.cwd(),
      containerWorkdir: "/workspace",
      containerHome: "/home/agent",
      user: "1000:1000",
    },
  });
  const read = tools.find((tool) => tool.name === "read");
  assert.ok(read);
  if (!read) {
    return;
  }

  await assert.rejects(
    async () =>
      await read.execute!(
        "tool-read-denied",
        {
          path: "/etc/hosts",
        },
        undefined,
        undefined,
        undefined as never
      ),
    new RegExp(getWorkspacePathNotAllowedMessage())
  );
});
