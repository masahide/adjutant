import assert from "node:assert/strict";
import test from "node:test";

import {
  toPermissionSummary,
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
