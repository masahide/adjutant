import assert from "node:assert/strict";
import test from "node:test";

import {
  mapToolExecutionEnd,
  mapToolExecutionStart,
} from "../../../src/agent-worker-acp/tool-call-mapper.js";

test("mapToolExecutionStart maps legacy start event to tool_call", () => {
  const update = mapToolExecutionStart({
    event: "tool_execution_start",
    toolCallId: "call_1",
    name: "run tests",
    kind: "execute",
    rawInput: { command: "pnpm test" },
  });

  assert.equal(update.sessionUpdate, "tool_call");
  assert.equal(update.toolCallId, "call_1");
  assert.equal(update.status, "pending");
  assert.deepEqual(update.rawInput, { command: "pnpm test" });
});

test("mapToolExecutionEnd maps legacy end event to tool_call_update", () => {
  const update = mapToolExecutionEnd({
    event: "tool_execution_end",
    toolCallId: "call_1",
    name: "run tests",
    status: "error",
    rawOutput: { exitCode: 1 },
    error: "failed",
  });

  assert.equal(update.sessionUpdate, "tool_call_update");
  assert.equal(update.toolCallId, "call_1");
  assert.equal(update.status, "failed");
  assert.deepEqual(update.rawOutput, { exitCode: 1 });
  assert.equal(update.content?.[0]?.content.text, "failed");
});
