import assert from "node:assert/strict";
import test from "node:test";

import type { AgentRunner } from "../../../src/assistant/agent-runner.js";
import { AgentRunnerAdapter } from "../../../src/agent-worker-acp/adapters/agent-runner-adapter.js";

test("AgentRunnerAdapter.prompt emits session/update from callbacks", async () => {
  const notifications: Array<{
    method: string;
    params: { sessionId: string; update: Record<string, unknown> };
  }> = [];

  const runAgentMock: AgentRunner = async (options) => {
    options.callbacks?.onTextDelta?.("delta");
    options.callbacks?.onToolCall?.({
      event: "tool_execution_start",
      toolCallId: "call_1",
      name: "run tests",
      rawInput: { command: "pnpm check" },
    });
    options.callbacks?.onToolCall?.({
      event: "tool_execution_end",
      toolCallId: "call_1",
      name: "run tests",
      status: "ok",
      rawOutput: { exitCode: 0 },
    });
    options.callbacks?.onTerminalRecord?.({
      runId: options.runId,
      sessionKey: options.sessionKey,
      actionType: "assistant_final",
      status: "recorded",
      timelineOffset: 42,
    });

    return {
      runId: options.runId,
      text: "done",
      stopReason: "end_turn",
    };
  };

  const adapter = new AgentRunnerAdapter({
    runAgent: runAgentMock,
    emitNotification: (notification) => {
      notifications.push(notification as (typeof notifications)[number]);
    },
  });

  const result = await adapter.prompt({ sessionId: "sess_1", prompt: "hello" });

  assert.equal(result.stopReason, "end_turn");
  assert.equal(result.text, "done");
  assert.equal(notifications.length, 4);
  assert.equal(notifications[0]?.method, "session/update");
  assert.equal(notifications[0]?.params.update.sessionUpdate, "agent_message_chunk");
  assert.equal(notifications[1]?.params.update.sessionUpdate, "tool_call");
  assert.equal(notifications[2]?.params.update.sessionUpdate, "tool_call_update");
  assert.equal(notifications[3]?.params.update.sessionUpdate, "tool_call_update");
});

test("AgentRunnerAdapter.cancelSession aborts active run", async () => {
  let observedAbort = false;

  const runAgentMock: AgentRunner = (options) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        resolve({
          runId: options.runId,
          text: "late",
          stopReason: "end_turn",
        });
      }, 40);

      options.signal?.addEventListener("abort", () => {
        observedAbort = true;
        clearTimeout(timer);
        reject(new Error("aborted"));
      });
    });

  const adapter = new AgentRunnerAdapter({
    runAgent: runAgentMock,
    emitNotification: () => {},
  });

  const promise = adapter.prompt({ sessionId: "sess_abort", prompt: "cancel me" });
  const cancelled = adapter.cancelSession("sess_abort");
  const result = await promise;

  assert.equal(cancelled, true);
  assert.equal(observedAbort, true);
  assert.equal(result.stopReason, "cancelled");
});
