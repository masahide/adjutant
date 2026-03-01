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

test("runAgent reuses agent session when sessionId is provided", async () => {
  let createSessionCount = 0;
  const prompts: string[] = [];
  let disposeCount = 0;

  setAgentRunnerRuntimeForTest({
    isExternalRunnerEnabled: () => true,
    createSession: async () => {
      createSessionCount += 1;
      const listeners: Array<(event: unknown) => void> = [];
      const history: string[] = [];
      const session = {
        state: {
          messages: [] as unknown[],
        },
        subscribe: (listener: (event: unknown) => void) => {
          listeners.push(listener);
          return () => {};
        },
        prompt: async (text: string) => {
          prompts.push(text);
          history.push(text);
          listeners.forEach((listener) => {
            listener({
              type: "message_update",
              assistantMessageEvent: {
                type: "text_delta",
                delta: `turn-${history.length}`,
              },
            });
          });
          session.state.messages = [
            {
              role: "assistant",
              content: [{ type: "text", text: `history:${history.join(" -> ")}` }],
            },
          ];
        },
        dispose: () => {
          disposeCount += 1;
        },
        abort: async () => {},
      };
      return { session };
    },
    cwd: () => process.cwd(),
  });

  try {
    const first = await runAgent({
      runId: "run_reuse_1",
      sessionId: "sess_reuse",
      sessionKey: "thr_reuse",
      prompt: "first",
    });
    const second = await runAgent({
      runId: "run_reuse_2",
      sessionId: "sess_reuse",
      sessionKey: "thr_reuse",
      prompt: "second",
    });

    assert.equal(createSessionCount, 1);
    assert.deepEqual(prompts, ["first", "second"]);
    assert.equal(first.text, "history:first");
    assert.equal(second.text, "history:first -> second");
    assert.equal(disposeCount, 0);
  } finally {
    setAgentRunnerRuntimeForTest(null);
  }
});
