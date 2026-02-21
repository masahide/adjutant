import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HeartbeatResultWriter } from "../../src/assistant/heartbeat-result-writer.js";

describe("heartbeat-result-writer", () => {
  it("event emit と run record 永続化を行う", async () => {
    const emitted: Array<Record<string, unknown>> = [];
    const records: Array<Record<string, unknown>> = [];
    const writer = new HeartbeatResultWriter({
      now: () => new Date("2026-02-21T00:00:00.000Z"),
      emitHeartbeatEvent: (payload) => {
        emitted.push(payload as unknown as Record<string, unknown>);
      },
      appendRunRecord: async (_dataDir, record) => {
        records.push(record as unknown as Record<string, unknown>);
      },
    });

    const result = await writer.finalize({
      dataDir: "/tmp/data",
      runAt: new Date("2026-02-21T00:00:00.000Z"),
      sessionKey: "main",
      triggerReason: "timer",
      result: { status: "skipped", reason: "quiet-hours" },
      event: { status: "skipped", reason: "quiet-hours", indicatorType: "ok" },
    });

    assert.deepEqual(result, { status: "skipped", reason: "quiet-hours" });
    assert.equal(emitted.length, 1);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.triggerReason, "timer");
  });
});
