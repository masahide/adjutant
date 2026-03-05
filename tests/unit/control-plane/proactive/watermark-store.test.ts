import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { WatermarkStore } from "../../../../src/control-plane/proactive/watermark-store.js";

test("assistant_final のみ handled watermark を前進させる", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "adjutant-watermark-store-"));
  t.after(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  const store = WatermarkStore.fromStateDir(stateDir);
  await store.initialize();

  await store.applyTerminalRecord({
    sessionKey: "slack:channel:C111",
    actionType: "assistant_error",
    offset: 10,
  });
  let loaded = await store.load();
  assert.equal(loaded.sessions["slack:channel:C111"]?.handled.lastHandledOffset, undefined);

  await store.applyTerminalRecord({
    sessionKey: "slack:channel:C111",
    actionType: "assistant_final",
    offset: 11,
  });
  loaded = await store.load();
  assert.equal(loaded.sessions["slack:channel:C111"]?.handled.lastHandledOffset, 11);

  await store.applyTerminalRecord({
    sessionKey: "slack:channel:C111",
    actionType: "assistant_aborted",
    offset: 12,
  });
  loaded = await store.load();
  assert.equal(loaded.sessions["slack:channel:C111"]?.handled.lastHandledOffset, 11);
});

test("timeline truncate を検知したら scan offset と session 状態を初期化する", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "adjutant-watermark-store-truncate-"));
  t.after(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  const timelinePath = join(stateDir, "timeline.jsonl");
  await writeFile(timelinePath, '{"schema":"adjutant.timeline.record.v1.5"}\n', "utf8");

  const store = WatermarkStore.fromStateDir(stateDir);
  await store.initialize();
  await store.setScanOffsets({
    lastScannedOffset: 9_999,
    lastGoodOffset: 9_999,
  });
  await store.updateOpenPosts("slack:channel:C999", {
    openPostCount: 2,
    oldestOpenAt: "2026-03-05T00:00:00.000Z",
    oldestActor: "U999",
  });

  const recovered = await store.recoverIfTimelineTruncated();
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.watermarks.scan.lastScannedOffset, 0);
  assert.equal(recovered.watermarks.scan.lastGoodOffset, 0);
  assert.deepEqual(recovered.watermarks.sessions, {});
});
