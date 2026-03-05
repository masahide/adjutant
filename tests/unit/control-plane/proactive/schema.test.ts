import assert from "node:assert/strict";
import test from "node:test";

import {
  TIMELINE_RECORD_SCHEMA_V1_5,
  WATERMARKS_SCHEMA_V1,
  validateTimelineRecordV1_5,
  validateWatermarksV1,
} from "../../../../src/control-plane/proactive/schema.js";

test("validateTimelineRecordV1_5: event record を受理する", () => {
  const valid = validateTimelineRecordV1_5({
    schema: TIMELINE_RECORD_SCHEMA_V1_5,
    recordType: "event",
    sessionKey: "slack:channel:C111",
    uid: "slack:C111@1762300000.100",
    ts: "2026-03-05T01:00:00.000Z",
    loggedAt: "2026-03-05T01:00:00.001Z",
    event: {
      schema: "adjutant.event.v1.1",
      uid: "slack:C111@1762300000.100",
      source: "slack",
      kind: "post",
      ts: "2026-03-05T01:00:00.000Z",
      detail: {
        slack: {
          channel_id: "C111",
          message_ts: "1762300000.100",
          text: "hello",
        },
      },
    },
  });

  assert.equal(valid, true);
});

test("validateTimelineRecordV1_5: actionType が不正なら reject", () => {
  const valid = validateTimelineRecordV1_5({
    schema: TIMELINE_RECORD_SCHEMA_V1_5,
    recordType: "action",
    sessionKey: "main",
    uid: "run:1:action",
    ts: "2026-03-05T01:00:00.000Z",
    loggedAt: "2026-03-05T01:00:00.001Z",
    actionType: "assistant_done",
  });

  assert.equal(valid, false);
});

test("validateWatermarksV1: schema v1 を受理する", () => {
  const valid = validateWatermarksV1({
    schema: WATERMARKS_SCHEMA_V1,
    scan: {
      lastScannedOffset: 120,
      lastGoodOffset: 120,
    },
    sessions: {
      "slack:channel:C111": {
        handled: {
          lastHandledOffset: 110,
        },
        open: {
          openPostCount: 2,
          oldestOpenAt: "2026-03-05T00:59:00.000Z",
          oldestActor: "U111",
        },
      },
    },
  });

  assert.equal(valid, true);
});

test("validateWatermarksV1: 負の offset は reject", () => {
  const valid = validateWatermarksV1({
    schema: WATERMARKS_SCHEMA_V1,
    scan: {
      lastScannedOffset: -1,
      lastGoodOffset: 0,
    },
    sessions: {},
  });

  assert.equal(valid, false);
});
