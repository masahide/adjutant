import assert from "node:assert/strict";
import test from "node:test";

import {
  toPermissionSummary,
  type ChatStreamEvent,
  type ToolEventRecord,
  type StreamEventType,
} from "../../../../src/control-plane/contracts/http-api.js";

test("toPermissionSummary converts createdAt to requestedAt", () => {
  const summary = toPermissionSummary({
    requestId: "perm_1",
    sessionId: "sess_1",
    runId: "run_1",
    toolCallId: "tool_1",
    title: "allow execution",
    createdAt: "2026-02-28T12:00:00.000Z",
  });

  assert.deepEqual(summary, {
    requestId: "perm_1",
    sessionId: "sess_1",
    runId: "run_1",
    toolCallId: "tool_1",
    title: "allow execution",
    requestedAt: "2026-02-28T12:00:00.000Z",
  });
});

test("StreamEventType accepts ACP naming convention with slash separator", () => {
  const type: StreamEventType = "permission/requested";
  assert.equal(type, "permission/requested");
});

test("StreamEventType accepts heartbeat event", () => {
  const type: StreamEventType = "heartbeat";
  assert.equal(type, "heartbeat");
});

test("ChatStreamEvent / ToolEventRecord keep new tool I/O fields optional", () => {
  const legacyEvent: ChatStreamEvent = {
    seq: 1,
    state: "delta",
    runId: "session:sess_1:run:1",
    sessionKey: "main",
    message: "hello",
  };
  assert.equal(legacyEvent.message, "hello");

  const withToolIo: ChatStreamEvent = {
    seq: 2,
    state: "delta",
    runId: "session:sess_1:run:1",
    sessionKey: "main",
    toolCallId: "call_1",
    toolStatus: "completed",
    toolInput: { cmd: "pnpm check" },
    toolOutput: { exitCode: 0 },
    toolError: undefined,
  };
  assert.deepEqual(withToolIo.toolOutput, { exitCode: 0 });

  const toolRecord: ToolEventRecord = {
    runId: "session:sess_1:run:1",
    sessionId: "sess_1",
    toolCallId: "call_1",
    status: "completed",
    updatedAt: "2026-03-02T00:00:00.000Z",
    rawInput: { cmd: "pnpm check" },
    rawOutput: { exitCode: 0 },
  };
  assert.deepEqual(toolRecord.rawInput, { cmd: "pnpm check" });
});
