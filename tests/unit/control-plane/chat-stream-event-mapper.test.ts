import assert from "node:assert/strict";
import test from "node:test";

import {
  mapAbortToChatStreamEvent,
  mapPermissionEventToChatStreamEvent,
  mapPromptResultToChatStreamEvent,
  mapRunFailureToChatStreamEvent,
  mapSessionUpdateToChatStreamEvent,
} from "../../../src/control-plane/http/chat-stream-event-mapper.js";

test("session/update agent_message_chunk を delta に変換できる", () => {
  const event = mapSessionUpdateToChatStreamEvent({
    runId: "session:sess_1:run:1",
    sessionKey: "main",
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "hello" },
    },
  });
  assert.equal(event?.state, "delta");
  assert.equal(event?.message, "hello");
});

test("session/update tool_call と tool_call_update を変換できる", () => {
  const started = mapSessionUpdateToChatStreamEvent({
    runId: "session:sess_1:run:1",
    sessionKey: "main",
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "call_1",
      title: "grep",
    },
  });
  assert.equal(started?.toolStatus, "started");
  assert.equal(started?.toolCallId, "call_1");

  const completed = mapSessionUpdateToChatStreamEvent({
    runId: "session:sess_1:run:1",
    sessionKey: "main",
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "call_1",
      status: "completed",
      title: "grep",
    },
  });
  assert.equal(completed?.toolStatus, "completed");
});

test("session/prompt 成功結果を final に変換できる", () => {
  const event = mapPromptResultToChatStreamEvent({
    runId: "session:sess_1:run:1",
    sessionKey: "main",
    text: "done",
  });
  assert.deepEqual(event, {
    state: "final",
    runId: "session:sess_1:run:1",
    sessionKey: "main",
    message: "done",
  });
});

test("RunLifecycle fail summary を error に変換できる", () => {
  const event = mapRunFailureToChatStreamEvent({
    runId: "session:sess_1:run:1",
    sessionKey: "main",
    summary: {
      errorCode: "WORKER_TIMEOUT",
      errorMessage: "deadline exceeded",
    },
  });
  assert.equal(event.state, "error");
  assert.equal(event.errorMessage, "WORKER_TIMEOUT: deadline exceeded");
});

test("PermissionGateway requested/resolved を変換できる", () => {
  const requested = mapPermissionEventToChatStreamEvent({
    runId: "session:sess_1:run:1",
    sessionKey: "main",
    event: {
      type: "permission/requested",
      payload: {
        requestId: "perm_1",
        title: "Allow tool",
        toolCallId: "call_1",
      },
    },
  });
  assert.equal(requested?.permissionRequest?.requestId, "perm_1");

  const resolved = mapPermissionEventToChatStreamEvent({
    runId: "session:sess_1:run:1",
    sessionKey: "main",
    event: {
      type: "permission/resolved",
      payload: {
        requestId: "perm_1",
        outcome: "allow",
      },
    },
  });
  assert.equal(resolved?.permissionResolved?.outcome, "allow");
});

test("abort を aborted に変換できる", () => {
  const event = mapAbortToChatStreamEvent({
    runId: "session:sess_1:run:1",
    sessionKey: "main",
  });
  assert.deepEqual(event, {
    state: "aborted",
    runId: "session:sess_1:run:1",
    sessionKey: "main",
  });
});
