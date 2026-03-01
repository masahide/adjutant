import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runAgent, setAgentRunnerRuntimeForTest } from "../../../src/assistant/agent-runner.js";

test("runAgent performs pre-compaction memory flush and retries after compact on overflow", async (t) => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "adjutant-compaction-"));
  t.after(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  const promptCalls: string[] = [];
  let mainPromptAttempts = 0;
  let compactCalled = 0;

  setAgentRunnerRuntimeForTest({
    isExternalRunnerEnabled: () => true,
    cwd: () => workspaceDir,
    createSession: async () => {
      return {
        session: {
          state: {
            messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
          },
          subscribe: () => () => {},
          getContextUsage: () => ({ tokens: 90_000, contextWindow: 100_000 }),
          compact: async () => {
            compactCalled += 1;
          },
          prompt: async (text: string) => {
            promptCalls.push(text);
            if (text.includes("Pre-compaction memory flush")) {
              return;
            }
            mainPromptAttempts += 1;
            if (mainPromptAttempts === 1) {
              throw new Error("context overflow");
            }
          },
          dispose: () => {},
          abort: async () => {},
        },
      };
    },
  });

  try {
    const result = await runAgent({
      runId: "run_compaction_1",
      sessionKey: "main",
      prompt: "please continue",
      memoryScope: "main",
      origin: "user",
    });

    assert.equal(result.text, "done");
    assert.equal(promptCalls.length, 3);
    assert.equal(promptCalls[0]?.includes("Pre-compaction memory flush"), true);
    assert.equal(promptCalls[1]?.includes("please continue"), true);
    assert.equal(promptCalls[2]?.includes("please continue"), true);
    assert.equal(compactCalled, 1);
  } finally {
    setAgentRunnerRuntimeForTest(null);
  }
});
