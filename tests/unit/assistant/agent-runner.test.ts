import assert from "node:assert/strict";
import test from "node:test";

import { runAgent, setAgentRunnerRuntimeForTest } from "../../../src/assistant/agent-runner.js";

test("runAgent uses external runner path when enabled (non-echo)", async () => {
  let promptCalled = false;
  setAgentRunnerRuntimeForTest({
    isExternalRunnerEnabled: () => true,
    createSession: async () => {
      const listeners: Array<(event: unknown) => void> = [];
      return {
        session: {
          state: {
            messages: [
              {
                role: "assistant",
                content: [{ type: "text", text: "external-final-text" }],
              },
            ],
          },
          subscribe: (listener) => {
            listeners.push(listener);
            return () => {};
          },
          prompt: async () => {
            promptCalled = true;
            listeners.forEach((listener) => {
              listener({
                type: "message_update",
                assistantMessageEvent: { type: "text_delta", delta: "external-delta" },
              });
            });
          },
          dispose: () => {},
          abort: async () => {},
        },
      };
    },
    cwd: () => process.cwd(),
  });

  try {
    const deltas: string[] = [];
    const result = await runAgent({
      runId: "run_1",
      sessionKey: "main",
      prompt: "hello",
      callbacks: {
        onTextDelta: (delta) => deltas.push(delta),
      },
    });

    assert.equal(promptCalled, true);
    assert.equal(result.text, "external-final-text");
    assert.notEqual(result.text, "hello");
    assert.deepEqual(deltas, ["external-delta"]);
  } finally {
    setAgentRunnerRuntimeForTest(null);
  }
});

test("runAgent keeps echo fallback when external runner is disabled", async () => {
  setAgentRunnerRuntimeForTest({
    isExternalRunnerEnabled: () => false,
  });
  try {
    const result = await runAgent({
      runId: "run_2",
      sessionKey: "main",
      prompt: "echo-me",
    });
    assert.equal(result.text, "echo-me");
    assert.equal(result.stopReason, "end_turn");
  } finally {
    setAgentRunnerRuntimeForTest(null);
  }
});
