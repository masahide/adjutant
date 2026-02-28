import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createTimelineRecordV1_5,
  isTimelineRecordV1_5,
  validateTimelineRecordV1_5,
} from "../../src/proactive/timeline-record.js";
import { TIMELINE_RECORD_SCHEMA_V1_5 } from "../../src/proactive/types.js";

describe("timeline-record", () => {
  it("v1.5 event record を validate できる", () => {
    const record = validateTimelineRecordV1_5({
      schema: TIMELINE_RECORD_SCHEMA_V1_5,
      recordType: "event",
      role: "user",
      sessionKey: "slack:channel:C123",
      uid: "uid-1",
      kind: "post",
      ts: "2026-02-22T10:30:00.000Z",
      loggedAt: "2026-02-22T10:30:01.000Z",
      actor: "U123",
    });

    assert.equal(record.sessionKey, "slack:channel:C123");
    assert.equal(record.kind, "post");
  });

  it("sessionKey がない record は reject する", () => {
    assert.throws(
      () =>
        validateTimelineRecordV1_5({
          schema: TIMELINE_RECORD_SCHEMA_V1_5,
          recordType: "event",
          role: "user",
          sessionKey: "",
          ts: "2026-02-22T10:30:00.000Z",
          loggedAt: "2026-02-22T10:30:01.000Z",
        }),
      /sessionKey/
    );
  });

  it("action record で actionType がない場合は reject する", () => {
    assert.throws(
      () =>
        validateTimelineRecordV1_5({
          schema: TIMELINE_RECORD_SCHEMA_V1_5,
          recordType: "action",
          role: "assistant",
          sessionKey: "main",
          ts: "2026-02-22T10:30:00.000Z",
          loggedAt: "2026-02-22T10:30:01.000Z",
        }),
      /actionType/
    );
  });

  it("create helper は schema/loggedAt を補完する", () => {
    const record = createTimelineRecordV1_5({
      recordType: "event",
      role: "user",
      sessionKey: "main",
      ts: "2026-02-22T10:30:00.000Z",
      uid: "uid-create",
    });
    assert.equal(record.schema, TIMELINE_RECORD_SCHEMA_V1_5);
    assert.equal(isTimelineRecordV1_5(record), true);
  });
});
