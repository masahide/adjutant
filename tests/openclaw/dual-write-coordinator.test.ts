import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createDualWriteCoordinator,
  type DualWriteRecord,
} from "../../src/openclaw/dual-write-coordinator.js";

function makeRecord(uid: string, recordType: string): DualWriteRecord {
  return {
    uid,
    recordType,
    ts: "2026-02-17T00:00:00.000Z",
  };
}

describe("dual-write-coordinator", () => {
  it("timeline 失敗時は pending-timeline に退避し retry で回復する", async () => {
    const timelineWritten: string[] = [];
    const sessionWritten: string[] = [];
    let failOnce = true;

    const coordinator = createDualWriteCoordinator({
      appendTimelineRecord: async (record) => {
        if (failOnce) {
          failOnce = false;
          throw new Error("timeline append failed");
        }
        timelineWritten.push(record.uid);
      },
      appendSessionRecord: async (record) => {
        sessionWritten.push(record.uid);
      },
    });

    const result = await coordinator.appendEvent({
      uid: "uid-1",
      timelineRecord: makeRecord("uid-1", "event"),
      sessionRecord: makeRecord("uid-1", "event"),
    });
    assert.equal(result.status, "pending-timeline");
    assert.equal(coordinator.hasPendingTimelineWrites("uid-1"), true);
    assert.deepEqual(sessionWritten, []);

    const retried = await coordinator.retryPending();
    assert.equal(retried.timelineRecovered, 1);
    assert.equal(retried.sessionRecovered, 1);
    assert.deepEqual(timelineWritten, ["uid-1"]);
    assert.deepEqual(sessionWritten, ["uid-1"]);

    const second = await coordinator.retryPending();
    assert.equal(second.sessionRecovered, 0);
    assert.deepEqual(sessionWritten, ["uid-1"]);
    assert.equal(coordinator.hasPendingTimelineWrites("uid-1"), false);
    assert.equal(coordinator.hasPendingSessionBackfill("uid-1"), false);
  });

  it("session 失敗時は pending-session-backfill に退避し replay で回復する", async () => {
    const timelineWritten: string[] = [];
    const sessionWritten: string[] = [];
    let sessionFailOnce = true;

    const coordinator = createDualWriteCoordinator({
      appendTimelineRecord: async (record) => {
        timelineWritten.push(record.uid);
      },
      appendSessionRecord: async (record) => {
        if (sessionFailOnce) {
          sessionFailOnce = false;
          throw new Error("session append failed");
        }
        sessionWritten.push(record.uid);
      },
    });

    const result = await coordinator.appendEvent({
      uid: "uid-2",
      timelineRecord: makeRecord("uid-2", "event"),
      sessionRecord: makeRecord("uid-2", "event"),
    });
    assert.equal(result.status, "pending-session-backfill");
    assert.equal(coordinator.hasPendingSessionBackfill("uid-2"), true);
    assert.deepEqual(timelineWritten, ["uid-2"]);
    assert.deepEqual(sessionWritten, []);

    const retried = await coordinator.retryPending();
    assert.equal(retried.sessionRecovered, 1);
    assert.deepEqual(sessionWritten, ["uid-2"]);
    assert.equal(coordinator.hasPendingSessionBackfill("uid-2"), false);

    const duplicate = await coordinator.appendEvent({
      uid: "uid-2",
      timelineRecord: makeRecord("uid-2", "event"),
      sessionRecord: makeRecord("uid-2", "event"),
    });
    assert.equal(duplicate.status, "committed");
    assert.deepEqual(timelineWritten, ["uid-2"]);
    assert.deepEqual(sessionWritten, ["uid-2"]);
  });

  it("backfill が長時間未解消なら health warning を出す", async () => {
    let now = 10_000;
    const warnings: Array<{ message: string; meta?: Record<string, unknown> }> = [];

    const coordinator = createDualWriteCoordinator({
      nowMs: () => now,
      backfillWarningMs: 1_000,
      appendTimelineRecord: async () => {},
      appendSessionRecord: async () => {
        throw new Error("session still failed");
      },
      onWarn: (message, meta) => {
        warnings.push({ message, meta });
      },
    });

    await coordinator.appendEvent({
      uid: "uid-3",
      timelineRecord: makeRecord("uid-3", "event"),
      sessionRecord: makeRecord("uid-3", "event"),
    });
    assert.equal(coordinator.hasPendingSessionBackfill("uid-3"), true);

    now += 1_500;
    const retried = await coordinator.retryPending();
    assert.equal(retried.sessionRecovered, 0);
    assert.equal(coordinator.hasPendingSessionBackfill("uid-3"), true);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]?.message, "dual-write-backfill-stalled");
    assert.equal(warnings[0]?.meta?.uid, "uid-3");
  });
});
