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
    workspaceDir: () => process.cwd(),
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
    workspaceDir: () => process.cwd(),
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

test("runAgent mock runner can emit fake tool call failure", async () => {
  process.env.ADJUTANT_TEST_MOCK_RUNNER = "1";
  process.env.ADJUTANT_TEST_MOCK_TOOL_CALLS = "1";
  process.env.ADJUTANT_TEST_MOCK_TOOL_NAME = "play_slack_search";
  process.env.ADJUTANT_TEST_MOCK_TOOL_STATUS = "failed";
  process.env.ADJUTANT_TEST_MOCK_TOOL_OUTPUT = "timeout after 180000ms";
  process.env.ADJUTANT_TEST_MOCK_TOOL_ERROR = "timeout after 180000ms";
  process.env.ADJUTANT_TEST_MOCK_TEXT = '{"action":"no_action","reason":"informational"}';

  const toolEvents: unknown[] = [];
  try {
    const result = await runAgent({
      runId: "run_mock_tool_1",
      sessionKey: "slack-activity",
      prompt: "notification prompt",
      callbacks: {
        onToolCall: (event) => toolEvents.push(event),
      },
    });

    assert.equal(result.text, '{"action":"no_action","reason":"informational"}');
    assert.equal(toolEvents.length, 2);
    assert.deepEqual(toolEvents[0], {
      event: "tool_execution_start",
      toolCallId: "mock_tool_call_1",
      name: "play_slack_search",
      title: "play_slack_search",
      kind: "search",
      rawInput: { prompt: "notification prompt" },
    });
    assert.deepEqual(toolEvents[1], {
      event: "tool_execution_end",
      toolCallId: "mock_tool_call_1",
      name: "play_slack_search",
      status: "error",
      error: "timeout after 180000ms",
      rawOutput: "timeout after 180000ms",
    });
  } finally {
    delete process.env.ADJUTANT_TEST_MOCK_RUNNER;
    delete process.env.ADJUTANT_TEST_MOCK_TOOL_CALLS;
    delete process.env.ADJUTANT_TEST_MOCK_TOOL_NAME;
    delete process.env.ADJUTANT_TEST_MOCK_TOOL_STATUS;
    delete process.env.ADJUTANT_TEST_MOCK_TOOL_OUTPUT;
    delete process.env.ADJUTANT_TEST_MOCK_TOOL_ERROR;
    delete process.env.ADJUTANT_TEST_MOCK_TEXT;
    setAgentRunnerRuntimeForTest(null);
  }
});
