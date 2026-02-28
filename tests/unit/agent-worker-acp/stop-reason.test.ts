import assert from "node:assert/strict";
import test from "node:test";

import { normalizeStopReason } from "../../../src/agent-worker-acp/stop-reason.js";

test("normalizeStopReason maps known values to ACP stop reasons", () => {
  assert.equal(normalizeStopReason("end_turn"), "end_turn");
  assert.equal(normalizeStopReason("aborted"), "cancelled");
  assert.equal(normalizeStopReason("length"), "max_tokens");
  assert.equal(normalizeStopReason("too_many_turn_requests"), "max_turn_requests");
  assert.equal(normalizeStopReason("refused"), "refusal");
});

test("normalizeStopReason falls back to end_turn", () => {
  assert.equal(normalizeStopReason(undefined), "end_turn");
  assert.equal(normalizeStopReason("unknown"), "end_turn");
});
