import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createWatermarkStore } from "../../src/proactive/watermark-store.js";
import { WATERMARKS_SCHEMA_V1 } from "../../src/proactive/types.js";

describe("watermark-store", () => {
  it("load/save でき、tmp ファイルが残らない", async () => {
    const dir = await mkdtemp(`${tmpdir()}/adjutant-watermark-store-`);
    try {
      const timelinePath = join(dir, "timeline.jsonl");
      const watermarksPath = join(dir, "watermarks.json");
      await writeFile(timelinePath, "", "utf8");

      const store = createWatermarkStore({
        path: watermarksPath,
        timelinePath,
      });

      const empty = await store.load();
      assert.equal(empty.schema, WATERMARKS_SCHEMA_V1);
      assert.equal(empty.scan.lastScannedOffset, 0);
      assert.deepEqual(empty.sessions, {});

      await store.setScanOffsets({ lastScannedOffset: 120, lastGoodOffset: 120 });
      const saved = await store.load();
      assert.equal(saved.scan.lastScannedOffset, 120);
      assert.equal(saved.scan.lastGoodOffset, 120);

      const files = await readdir(dir);
      assert.equal(
        files.some((name) => name.includes(".tmp-")),
        false
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("pruning 条件に合う session を削除する", async () => {
    const dir = await mkdtemp(`${tmpdir()}/adjutant-watermark-store-`);
    try {
      const timelinePath = join(dir, "timeline.jsonl");
      const watermarksPath = join(dir, "watermarks.json");
      await writeFile(timelinePath, "", "utf8");

      const store = createWatermarkStore({
        path: watermarksPath,
        timelinePath,
      });

      await store.setScanOffsets({ lastScannedOffset: 500, lastGoodOffset: 500 });
      await store.advanceHandled("session:drop", { offset: 300, ts: "2026-02-22T10:00:00.000Z" });
      await store.updateOpenPosts("session:drop", { openPostCount: 0 });
      await store.advanceHandled("session:keep", { offset: 700, ts: "2026-02-22T10:00:00.000Z" });
      await store.updateOpenPosts("session:keep", { openPostCount: 0 });
      await store.pruneSessions();

      const loaded = await store.load();
      assert.equal(Object.keys(loaded.sessions).includes("session:drop"), false);
      assert.equal(Object.keys(loaded.sessions).includes("session:keep"), true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("timeline truncate を検知したら scan/sessions をリセットする", async () => {
    const dir = await mkdtemp(`${tmpdir()}/adjutant-watermark-store-`);
    try {
      const timelinePath = join(dir, "timeline.jsonl");
      const watermarksPath = join(dir, "watermarks.json");
      await writeFile(timelinePath, "", "utf8");

      const store = createWatermarkStore({
        path: watermarksPath,
        timelinePath,
      });

      await store.setScanOffsets({ lastScannedOffset: 999, lastGoodOffset: 900 });
      await store.advanceHandled("session:a", { offset: 500, ts: "2026-02-22T10:00:00.000Z" });

      const recovered = await store.recoverIfTimelineTruncated();
      assert.equal(recovered.recovered, true);
      assert.equal(recovered.watermarks.scan.lastScannedOffset, 0);
      assert.equal(recovered.watermarks.scan.lastGoodOffset, 0);
      assert.deepEqual(recovered.watermarks.sessions, {});
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("assistant_final のみ handled offset を進める", async () => {
    const dir = await mkdtemp(`${tmpdir()}/adjutant-watermark-store-`);
    try {
      const timelinePath = join(dir, "timeline.jsonl");
      const watermarksPath = join(dir, "watermarks.json");
      await writeFile(timelinePath, "", "utf8");

      const store = createWatermarkStore({
        path: watermarksPath,
        timelinePath,
      });

      await store.applyTerminalRecord({
        sessionKey: "session:terminal",
        actionType: "assistant_error",
        offset: 100,
        ts: "2026-02-22T10:00:00.000Z",
      });
      let loaded = await store.load();
      assert.equal(loaded.sessions["session:terminal"], undefined);

      await store.applyTerminalRecord({
        sessionKey: "session:terminal",
        actionType: "assistant_aborted",
        offset: 120,
        ts: "2026-02-22T10:01:00.000Z",
      });
      loaded = await store.load();
      assert.equal(loaded.sessions["session:terminal"], undefined);

      await store.applyTerminalRecord({
        sessionKey: "session:terminal",
        actionType: "assistant_final",
        offset: 140,
        ts: "2026-02-22T10:02:00.000Z",
      });
      loaded = await store.load();
      assert.equal(loaded.sessions["session:terminal"]?.handled.lastHandledOffset, 140);
      assert.equal(
        loaded.sessions["session:terminal"]?.handled.lastHandledTs,
        "2026-02-22T10:02:00.000Z"
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
