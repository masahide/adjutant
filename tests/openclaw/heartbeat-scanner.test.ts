import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  evaluateHeartbeatScan,
  parseTimelineJsonl,
  scanHeartbeatTimeline,
  type HeartbeatTimelineRecord,
} from "../../src/openclaw/heartbeat-scanner.js";

function makeRecord(overrides: Partial<HeartbeatTimelineRecord> = {}): HeartbeatTimelineRecord {
  return {
    recordType: "event",
    role: "user",
    kind: "post",
    uid: "uid-default",
    ts: 0,
    ...overrides,
  };
}

describe("heartbeat-scanner", () => {
  it("最新対応境界までに stale user post がなければ skip する", () => {
    const result = evaluateHeartbeatScan({
      nowMs: 10_000,
      heartbeatStaleMs: 1_000,
      records: [
        makeRecord({ uid: "uid-old-stale", ts: 0 }),
        makeRecord({ recordType: "action", role: "system", kind: "dispatch", uid: "act-1" }),
        makeRecord({ uid: "uid-fresh", ts: 9_500 }),
      ],
    });

    assert.equal(result.shouldRun, false);
    assert.equal(result.reason, "no-stale-post");
    assert.deepEqual(result.stalePostUids, []);
    assert.equal(result.boundaryFound, true);
  });

  it("stale user post があり pending-session-backfill 未滞留なら run する", () => {
    const result = evaluateHeartbeatScan({
      nowMs: 10_000,
      heartbeatStaleMs: 1_000,
      records: [
        makeRecord({ recordType: "action", role: "system", kind: "dispatch", uid: "act-1" }),
        makeRecord({ uid: "uid-stale", ts: 1_000 }),
      ],
      pendingSessionBackfillUids: [],
    });

    assert.equal(result.shouldRun, true);
    assert.equal(result.reason, "stale-post-found");
    assert.deepEqual(result.stalePostUids, ["uid-stale"]);
    assert.deepEqual(result.blockedPendingUids, []);
  });

  it("stale user post の uid が pending-session-backfill にあれば skip する", () => {
    const result = evaluateHeartbeatScan({
      nowMs: 10_000,
      heartbeatStaleMs: 1_000,
      records: [makeRecord({ uid: "uid-stale", ts: 1_000 })],
      pendingSessionBackfillUids: ["uid-stale"],
    });

    assert.equal(result.shouldRun, false);
    assert.equal(result.reason, "pending-session-backfill");
    assert.deepEqual(result.stalePostUids, []);
    assert.deepEqual(result.blockedPendingUids, ["uid-stale"]);
  });

  it("JSONL 逆走査 I/O は破損行を無視して判定できる", async () => {
    const tempDir = await mkdtemp(`${tmpdir()}/adjutant-heartbeat-scan-`);
    const timelinePath = join(tempDir, "timeline.jsonl");
    const lines = [
      JSON.stringify(makeRecord({ uid: "uid-a", ts: 1_000 })),
      "{broken-json",
      JSON.stringify(makeRecord({ recordType: "action", role: "assistant", kind: "reply" })),
      "",
    ].join("\n");

    await writeFile(timelinePath, lines, "utf8");

    const parsed = parseTimelineJsonl(lines);
    assert.equal(parsed.length, 2);

    const result = await scanHeartbeatTimeline({
      timelinePath,
      nowMs: 10_000,
      heartbeatStaleMs: 1_000,
    });
    assert.equal(result.shouldRun, false);
    assert.equal(result.reason, "no-stale-post");

    await rm(tempDir, { recursive: true, force: true });
  });
});
