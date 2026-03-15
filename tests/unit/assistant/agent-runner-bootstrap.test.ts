import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runAgent, setAgentRunnerRuntimeForTest } from "../../../src/assistant/agent-runner.js";

test("runAgent injects bootstrap context for user main run and creates missing bootstrap files", async (t) => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "adjutant-bootstrap-"));
  t.after(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });
  await mkdir(join(workspaceDir, "memory"), { recursive: true });
  await writeFile(join(workspaceDir, "MEMORY.md"), "long term memory\n", "utf8");
  await writeFile(join(workspaceDir, "memory", "2026-03-15.md"), "daily memory\n", "utf8");

  const prompts: string[] = [];
  setAgentRunnerRuntimeForTest({
    isExternalRunnerEnabled: () => true,
    workspaceDir: () => workspaceDir,
    createSession: async () => {
      return {
        session: {
          state: {
            messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }],
          },
          subscribe: () => () => {},
          prompt: async (text: string) => {
            prompts.push(text);
          },
          dispose: () => {},
          abort: async () => {},
        },
      };
    },
  });

  try {
    const result = await runAgent({
      runId: "run_bootstrap_1",
      sessionKey: "main",
      prompt: "hello bootstrap",
      memoryScope: "main",
      origin: "user",
    });

    assert.equal(result.text, "ok");
    assert.equal(prompts.length >= 1, true);
    assert.equal(prompts[0]?.includes("# Project Context"), true);
    assert.equal(prompts[0]?.includes("## AGENTS.md"), true);
    assert.equal(prompts[0]?.includes("## MEMORY.md"), true);
    assert.equal(prompts[0]?.includes("long term memory"), true);
    assert.equal(prompts[0]?.includes("2026-03-15.md"), false);
    assert.equal(prompts[0]?.includes("daily memory"), false);
    assert.equal(prompts[0]?.includes("hello bootstrap"), true);

    const bootstrap = await readFile(join(workspaceDir, "BOOTSTRAP.md"), "utf8");
    assert.equal(bootstrap.length > 0, true);
  } finally {
    setAgentRunnerRuntimeForTest(null);
  }
});
