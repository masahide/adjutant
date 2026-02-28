import assert from "node:assert/strict";
import test from "node:test";

import {
  projectAgentMessageChunk,
  projectCurrentMode,
  projectPlan,
  projectTerminalRecord,
  toSessionUpdateNotification,
} from "../../../src/agent-worker-acp/session-update-projector.js";

test("projectAgentMessageChunk builds agent_message_chunk payload", () => {
  const update = projectAgentMessageChunk("hello");
  assert.equal(update.sessionUpdate, "agent_message_chunk");
  assert.equal(update.content.text, "hello");
});

test("projectPlan and projectCurrentMode build ACP updates", () => {
  const plan = projectPlan([{ step: "Implement", status: "in_progress" }]);
  const mode = projectCurrentMode("code");

  assert.equal(plan.sessionUpdate, "plan");
  assert.equal(plan.entries.length, 1);
  assert.equal(mode.sessionUpdate, "current_mode_update");
  assert.equal(mode.currentModeId, "code");
});

test("projectTerminalRecord maps to tool_call_update", () => {
  const update = projectTerminalRecord({
    runId: "run_1",
    actionType: "assistant_final",
    status: "recorded",
    timelineOffset: 10,
  });

  assert.equal(update.sessionUpdate, "tool_call_update");
  assert.equal(update.toolCallId, "terminal:run_1");
  assert.equal(update.status, "completed");
});

test("toSessionUpdateNotification wraps update into JSON-RPC notification", () => {
  const notification = toSessionUpdateNotification("sess_1", projectAgentMessageChunk("ok"));

  assert.equal(notification.jsonrpc, "2.0");
  assert.equal(notification.method, "session/update");
  assert.equal(notification.params.sessionId, "sess_1");
});
