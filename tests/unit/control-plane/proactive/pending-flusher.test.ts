import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createPendingFlusher } from "../../../../src/control-plane/proactive/pending-flusher.js";
import { WatermarkStore } from "../../../../src/control-plane/proactive/watermark-store.js";

function timelineLine(record: Record<string, unknown>): string {
  return JSON.stringify(record);
}

test("pending flusher: stale session を enqueue する", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "adjutant-pending-flusher-"));
  t.after(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  const timelinePath = join(stateDir, "timeline.jsonl");
  await writeFile(
    timelinePath,
    [
      timelineLine({
        schema: "adjutant.timeline.record.v1.5",
        recordType: "event",
        uid: "u1",
        sessionKey: "slack:channel:C111",
        ts: "2026-03-05T00:00:00.000Z",
        loggedAt: "2026-03-05T00:00:00.000Z",
        event: {
          schema: "adjutant.event.v1.1",
          uid: "slack:C111@1",
          source: "slack",
          kind: "post",
          actor: "U1",
          ts: "2026-03-05T00:00:00.000Z",
          detail: {
            slack: {
              channel_id: "C111",
              text: "first",
            },
          },
        },
      }),
    ].join("\n"),
    "utf8"
  );

  const watermarkStore = WatermarkStore.fromStateDir(stateDir);
  await watermarkStore.initialize();
  const fired: string[] = [];
  const flusher = createPendingFlusher({
    timelinePath,
    watermarkStore,
    staleMs: 30_000,
    nowMs: () => Date.parse("2026-03-05T00:10:00.000Z"),
    enqueueSession: async ({ sessionKey }) => {
      fired.push(sessionKey);
    },
  });

  const result = await flusher.tick();
  assert.equal(result.scannedRecords >= 1, true);
  assert.deepEqual(fired, ["slack:channel:C111"]);
});

test("pending flusher: 別人返信がある stale session は suppression する", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "adjutant-pending-flusher-"));
  t.after(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  const timelinePath = join(stateDir, "timeline.jsonl");
  await writeFile(
    timelinePath,
    [
      timelineLine({
        schema: "adjutant.timeline.record.v1.5",
        recordType: "event",
        uid: "u1",
        sessionKey: "slack:channel:C222",
        ts: "2026-03-05T00:00:00.000Z",
        loggedAt: "2026-03-05T00:00:00.000Z",
        event: {
          schema: "adjutant.event.v1.1",
          uid: "slack:C222@1",
          source: "slack",
          kind: "post",
          actor: "U1",
          ts: "2026-03-05T00:00:00.000Z",
          detail: {
            slack: {
              channel_id: "C222",
              text: "first",
            },
          },
        },
      }),
      timelineLine({
        schema: "adjutant.timeline.record.v1.5",
        recordType: "event",
        uid: "u2",
        sessionKey: "slack:channel:C222",
        ts: "2026-03-05T00:01:00.000Z",
        loggedAt: "2026-03-05T00:01:00.000Z",
        event: {
          schema: "adjutant.event.v1.1",
          uid: "slack:C222@2",
          source: "slack",
          kind: "post",
          actor: "U2",
          ts: "2026-03-05T00:01:00.000Z",
          detail: {
            slack: {
              channel_id: "C222",
              text: "reply",
            },
          },
        },
      }),
    ].join("\n"),
    "utf8"
  );

  const watermarkStore = WatermarkStore.fromStateDir(stateDir);
  await watermarkStore.initialize();
  const fired: string[] = [];
  const flusher = createPendingFlusher({
    timelinePath,
    watermarkStore,
    staleMs: 30_000,
    nowMs: () => Date.parse("2026-03-05T00:10:00.000Z"),
    enqueueSession: async ({ sessionKey }) => {
      fired.push(sessionKey);
    },
  });

  const result = await flusher.tick();
  assert.deepEqual(fired, []);
  assert.deepEqual(result.suppressedSessionKeys, ["slack:channel:C222"]);
});
