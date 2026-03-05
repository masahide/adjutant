import assert from "node:assert/strict";
import test from "node:test";

import {
  HEARTBEAT_RESULT_SCHEMA_V1,
  validateHeartbeatRunResultV1,
  validateReportHeartbeatStatusPayload,
} from "../../../../src/control-plane/heartbeat/schema.js";

test("validateReportHeartbeatStatusPayload: HEARTBEAT.md 契約 payload を受理する", () => {
  const valid = validateReportHeartbeatStatusPayload({
    status: "needs_attention",
    notify: true,
    reason: "stale thread detected",
  });
  assert.equal(valid, true);
});

test("validateReportHeartbeatStatusPayload: status が契約外なら reject", () => {
  const valid = validateReportHeartbeatStatusPayload({
    status: "ok",
    notify: true,
  });
  assert.equal(valid, false);
});

test("validateHeartbeatRunResultV1: 実行結果スキーマを受理する", () => {
  const valid = validateHeartbeatRunResultV1({
    schema: HEARTBEAT_RESULT_SCHEMA_V1,
    status: "ran",
    event: {
      status: "sent",
      reason: "needs attention",
    },
    ts: "2026-03-05T02:00:00.000Z",
    runId: "session:sess_1:run:10",
  });
  assert.equal(valid, true);
});

test("validateHeartbeatRunResultV1: event.status が契約外なら reject", () => {
  const valid = validateHeartbeatRunResultV1({
    schema: HEARTBEAT_RESULT_SCHEMA_V1,
    status: "ran",
    event: {
      status: "queued",
    },
    ts: "2026-03-05T02:00:00.000Z",
  });
  assert.equal(valid, false);
});
