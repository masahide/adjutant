import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createPendingFlusher } from "../../src/proactive/pending-flusher.js";
import { createWatermarkStore } from "../../src/proactive/watermark-store.js";

function timelineLine(record: Record<string, unknown>): string {
  return JSON.stringify(record);
}

describe("pending-flusher", () => {
  it("sessionKey 別境界で stale open post を検出する", async () => {
    const dir = await mkdtemp(`${tmpdir()}/adjutant-pending-flusher-`);
    try {
      const timelinePath = join(dir, "timeline.jsonl");
      const watermarksPath = join(dir, "watermarks.json");
      await writeFile(
        timelinePath,
        [
          timelineLine({
            schema: "adjutant.timeline.record.v1.5",
            recordType: "event",
            role: "user",
            kind: "post",
            uid: "a-post",
            sessionKey: "slack:channel:A",
            actor: "U1",
            ts: "2026-02-22T10:00:00.000Z",
            loggedAt: "2026-02-22T10:00:00.000Z",
          }),
          timelineLine({
            schema: "adjutant.timeline.record.v1.5",
            recordType: "action",
            role: "assistant",
            actionType: "assistant_final",
            runId: "run-a",
            sessionKey: "slack:channel:A",
            ts: "2026-02-22T10:01:00.000Z",
            loggedAt: "2026-02-22T10:01:00.000Z",
          }),
          timelineLine({
            schema: "adjutant.timeline.record.v1.5",
            recordType: "event",
            role: "user",
            kind: "post",
            uid: "b-post",
            sessionKey: "slack:channel:B",
            actor: "U2",
            ts: "2026-02-22T10:00:30.000Z",
            loggedAt: "2026-02-22T10:00:30.000Z",
          }),
        ].join("\n"),
        "utf8"
      );

      const fired: string[] = [];
      const store = createWatermarkStore({ path: watermarksPath, timelinePath });
      const flusher = createPendingFlusher({
        timelinePath,
        watermarkStore: store,
        staleMs: 60_000,
        nowMs: () => Date.parse("2026-02-22T10:10:00.000Z"),
        enqueueSession: async ({ sessionKey }) => {
          fired.push(sessionKey);
        },
      });

      const result = await flusher.tick();
      assert.equal(result.scannedRecords >= 3, true);
      assert.deepEqual(fired, ["slack:channel:B"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("他者返信がある stale session は suppression する", async () => {
    const dir = await mkdtemp(`${tmpdir()}/adjutant-pending-flusher-`);
    try {
      const timelinePath = join(dir, "timeline.jsonl");
      const watermarksPath = join(dir, "watermarks.json");
      await writeFile(
        timelinePath,
        [
          timelineLine({
            schema: "adjutant.timeline.record.v1.5",
            recordType: "event",
            role: "user",
            kind: "post",
            uid: "c-post-1",
            sessionKey: "slack:channel:C",
            actor: "U1",
            ts: "2026-02-22T10:00:00.000Z",
            loggedAt: "2026-02-22T10:00:00.000Z",
          }),
          timelineLine({
            schema: "adjutant.timeline.record.v1.5",
            recordType: "event",
            role: "user",
            kind: "post",
            uid: "c-post-2",
            sessionKey: "slack:channel:C",
            actor: "U2",
            ts: "2026-02-22T10:00:10.000Z",
            loggedAt: "2026-02-22T10:00:10.000Z",
          }),
        ].join("\n"),
        "utf8"
      );

      const fired: string[] = [];
      const store = createWatermarkStore({ path: watermarksPath, timelinePath });
      const flusher = createPendingFlusher({
        timelinePath,
        watermarkStore: store,
        staleMs: 60_000,
        nowMs: () => Date.parse("2026-02-22T10:10:00.000Z"),
        enqueueSession: async ({ sessionKey }) => {
          fired.push(sessionKey);
        },
      });

      const result = await flusher.tick();
      assert.deepEqual(fired, []);
      assert.deepEqual(result.suppressedSessionKeys, ["slack:channel:C"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("sessionKey なし旧レコードは無視する", async () => {
    const dir = await mkdtemp(`${tmpdir()}/adjutant-pending-flusher-`);
    try {
      const timelinePath = join(dir, "timeline.jsonl");
      const watermarksPath = join(dir, "watermarks.json");
      await writeFile(
        timelinePath,
        JSON.stringify({
          recordType: "event",
          role: "user",
          kind: "post",
          uid: "legacy-1",
          ts: "2026-02-22T10:00:00.000Z",
          loggedAt: "2026-02-22T10:00:00.000Z",
        }),
        "utf8"
      );

      const fired: string[] = [];
      const store = createWatermarkStore({ path: watermarksPath, timelinePath });
      const flusher = createPendingFlusher({
        timelinePath,
        watermarkStore: store,
        staleMs: 60_000,
        nowMs: () => Date.parse("2026-02-22T10:10:00.000Z"),
        enqueueSession: async ({ sessionKey }) => {
          fired.push(sessionKey);
        },
      });

      await flusher.tick();
      assert.deepEqual(fired, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
