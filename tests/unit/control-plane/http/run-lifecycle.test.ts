import assert from "node:assert/strict";
import test from "node:test";

import { toErrorSummary } from "../../../../src/control-plane/http/error-summary.js";
import { RunLifecycle } from "../../../../src/control-plane/http/run-lifecycle.js";

test("RunLifecycle updates status from accepted to completed", () => {
  const runLifecycle = new RunLifecycle({
    now: () => "2026-02-28T00:00:00.000Z",
    newMessageId: () => "msg_test",
  });

  const sessions = runLifecycle.sessions();
  sessions.set("main", {
    sessionId: "sess_1",
    runSequence: 0,
  });
  const session = sessions.get("main");
  assert.ok(session);

  const accepted = runLifecycle.beginRun("main", session);
  assert.equal(accepted.runId, "session:sess_1:run:1");
  assert.equal(runLifecycle.resolveRunId("sess_1"), "session:sess_1:run:1");

  runLifecycle.markRunning(accepted.runId);
  const completed = runLifecycle.completeRun(accepted.runId, "end_turn");
  assert.ok(completed);
  assert.equal(completed.status, "completed");
  assert.equal(completed.stopReason, "end_turn");

  runLifecycle.clearActiveSessionRun("sess_1");
  assert.equal(runLifecycle.resolveRunId("sess_1"), undefined);
});

test("RunLifecycle stores session recovery metadata when beginRun receives it", () => {
  const runLifecycle = new RunLifecycle({
    now: () => "2026-02-28T00:00:00.000Z",
    newMessageId: () => "msg_test",
  });
  const sessions = runLifecycle.sessions();
  sessions.set("main", {
    sessionId: "sess_1",
    runSequence: 0,
  });
  const session = sessions.get("main");
  assert.ok(session);

  const accepted = runLifecycle.beginRun("main", session, {
    sessionRecovered: false,
    sessionRecoveryMode: "fallback_new_session",
    sessionRecoveryReason: "INVALID_RECORD",
  });
  const run = runLifecycle.runs().get(accepted.runId);
  assert.ok(run);
  assert.equal(run.sessionRecovered, false);
  assert.equal(run.sessionRecoveryMode, "fallback_new_session");
  assert.equal(run.sessionRecoveryReason, "INVALID_RECORD");
});

test("RunLifecycle failRun stores normalized downstream error", () => {
  const runLifecycle = new RunLifecycle({
    now: () => "2026-02-28T00:00:00.000Z",
    newMessageId: () => "msg_test",
  });
  const sessions = runLifecycle.sessions();
  sessions.set("main", {
    sessionId: "sess_2",
    runSequence: 0,
  });
  const session = sessions.get("main");
  assert.ok(session);

  const accepted = runLifecycle.beginRun("main", session);
  const failed = runLifecycle.failRun(accepted.runId, toErrorSummary(new Error("boom")));
  assert.ok(failed);
  assert.equal(failed.status, "failed");
  assert.equal(failed.errorCode, "DOWNSTREAM_ERROR");
  assert.equal(failed.errorMessage, "boom");
});

test("RunLifecycle cancelRun only updates active run", () => {
  const runLifecycle = new RunLifecycle({
    now: () => "2026-02-28T00:00:00.000Z",
    newMessageId: () => "msg_test",
  });
  const sessions = runLifecycle.sessions();
  sessions.set("main", {
    sessionId: "sess_cancel",
    runSequence: 0,
  });
  const session = sessions.get("main");
  assert.ok(session);

  const accepted = runLifecycle.beginRun("main", session);
  const cancelled = runLifecycle.cancelRun(accepted.runId, "cancelled");
  assert.ok(cancelled);
  assert.equal(cancelled.status, "cancelled");

  const cancelledAgain = runLifecycle.cancelRun(accepted.runId, "cancelled");
  assert.equal(cancelledAgain, undefined);

  const completedAfterCancel = runLifecycle.completeRun(accepted.runId, "end_turn");
  assert.equal(completedAfterCancel, undefined);
});

test("RunLifecycle resolves idempotency duplicate and conflict", () => {
  const runLifecycle = new RunLifecycle({
    now: () => "2026-02-28T00:00:00.000Z",
    newMessageId: () => "msg_test",
  });
  const sessions = runLifecycle.sessions();
  sessions.set("main", {
    sessionId: "sess_3",
    runSequence: 0,
  });
  const session = sessions.get("main");
  assert.ok(session);

  const accepted = runLifecycle.beginRun("main", session);
  runLifecycle.bindIdempotency("main", "idem_1", '{"message":"hello"}', accepted);

  const duplicate = runLifecycle.resolveIdempotency("main", "idem_1", '{"message":"hello"}');
  assert.equal(duplicate.kind, "duplicate");
  if (duplicate.kind === "duplicate") {
    assert.equal(duplicate.accepted.runId, accepted.runId);
  }

  const conflict = runLifecycle.resolveIdempotency("main", "idem_1", '{"message":"other"}');
  assert.equal(conflict.kind, "conflict");
});

test("RunLifecycle beginRun keeps runSequence monotonic for detached session objects", () => {
  const runLifecycle = new RunLifecycle({
    now: () => "2026-02-28T00:00:00.000Z",
    newMessageId: () => "msg_test",
  });
  runLifecycle.sessions().set("main", {
    sessionId: "sess_detached",
    runSequence: 1,
  });

  const detached1 = { ...runLifecycle.sessions().get("main")! };
  const accepted2 = runLifecycle.beginRun("main", detached1);
  assert.equal(accepted2.runId, "session:sess_detached:run:2");

  const detached2 = { ...runLifecycle.sessions().get("main")! };
  const accepted3 = runLifecycle.beginRun("main", detached2);
  assert.equal(accepted3.runId, "session:sess_detached:run:3");
});

test("toErrorSummary maps non-Error values to string", () => {
  const summary = toErrorSummary({ code: 42 });
  assert.equal(summary.errorCode, "DOWNSTREAM_ERROR");
  assert.equal(summary.errorMessage, "[object Object]");
});

test("toErrorSummary maps worker transient codes to WORKER_CRASHED", () => {
  const summary = toErrorSummary(new Error("WORKER_NOT_READY: session/prompt"));
  assert.equal(summary.errorCode, "WORKER_CRASHED");
  assert.equal(summary.errorMessage, "session/prompt");
});

test("toErrorSummary keeps known code prefix and message", () => {
  const summary = toErrorSummary(new Error("WORKER_TIMEOUT: session/prompt"));
  assert.equal(summary.errorCode, "WORKER_TIMEOUT");
  assert.equal(summary.errorMessage, "session/prompt");
});
