import assert from "node:assert/strict";
import test from "node:test";

import { SessionExecutionRegistry } from "../../../src/agent-worker-acp/session-execution-registry.js";

test("SessionExecutionRegistry start/finish transitions", () => {
  const registry = new SessionExecutionRegistry();

  const started = registry.tryStart("sess_1");
  assert.ok(started);
  assert.equal(registry.isActive("sess_1"), true);

  registry.finish("sess_1", started.runId);
  assert.equal(registry.isActive("sess_1"), false);
});

test("SessionExecutionRegistry rejects parallel run in same session", () => {
  const registry = new SessionExecutionRegistry();

  const first = registry.tryStart("sess_busy");
  assert.ok(first);

  const second = registry.tryStart("sess_busy");
  assert.equal(second, null);
});

test("SessionExecutionRegistry cancel aborts active controller", () => {
  const registry = new SessionExecutionRegistry();

  const started = registry.tryStart("sess_cancel");
  assert.ok(started);
  assert.equal(started.controller.signal.aborted, false);

  const cancelled = registry.cancel("sess_cancel");
  assert.equal(cancelled, true);
  assert.equal(started.controller.signal.aborted, true);
});

test("SessionExecutionRegistry ignores finish with stale runId", () => {
  const registry = new SessionExecutionRegistry();

  const started = registry.tryStart("sess_stale");
  assert.ok(started);

  registry.finish("sess_stale", "run_stale");
  assert.equal(registry.isActive("sess_stale"), true);

  registry.finish("sess_stale", started.runId);
  assert.equal(registry.isActive("sess_stale"), false);
});
