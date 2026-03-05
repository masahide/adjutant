import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DeliverCompletionStore } from "../../src/control-plane/deliver-completion-store.js";

test("deliver completion store dedupes duplicate completed notification", () => {
  const store = new DeliverCompletionStore();

  const first = store.apply({
    messageId: "msg_1",
    status: "completed",
    finishedAt: "2026-02-28T12:00:01.000Z",
  });
  const duplicate = store.apply({
    messageId: "msg_1",
    status: "completed",
    finishedAt: "2026-02-28T12:00:01.000Z",
  });

  assert.equal(first.applied, true);
  assert.equal(duplicate.applied, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(store.get("msg_1")?.status, "completed");
});

test("deliver completion store keeps completed as terminal when failed arrives later", () => {
  const store = new DeliverCompletionStore();

  store.apply({
    messageId: "msg_2",
    status: "completed",
    finishedAt: "2026-02-28T12:00:01.000Z",
  });

  const laterFailed = store.apply({
    messageId: "msg_2",
    status: "failed",
    finishedAt: "2026-02-28T12:00:02.000Z",
    error: "timeout",
  });

  assert.equal(laterFailed.applied, false);
  assert.equal(laterFailed.final.status, "completed");
});

test("deliver completion store promotes failed -> completed when completion arrives out-of-order", () => {
  const store = new DeliverCompletionStore();

  store.apply({
    messageId: "msg_3",
    status: "failed",
    finishedAt: "2026-02-28T12:00:01.000Z",
    error: "network",
  });

  const recovery = store.apply({
    messageId: "msg_3",
    status: "completed",
    finishedAt: "2026-02-28T12:00:03.000Z",
  });

  assert.equal(recovery.applied, true);
  assert.equal(recovery.final.status, "completed");
  assert.equal(store.get("msg_3")?.status, "completed");
});

test("deliver completion store keeps completed terminal even if failed is retried after promotion", () => {
  const store = new DeliverCompletionStore();

  store.apply({
    messageId: "msg_4",
    status: "failed",
    finishedAt: "2026-02-28T12:00:01.000Z",
    error: "timeout",
  });
  store.apply({
    messageId: "msg_4",
    status: "completed",
    finishedAt: "2026-02-28T12:00:03.000Z",
  });

  const failedRetry = store.apply({
    messageId: "msg_4",
    status: "failed",
    finishedAt: "2026-02-28T12:00:04.000Z",
    error: "timeout",
  });

  assert.equal(failedRetry.applied, false);
  assert.equal(failedRetry.final.status, "completed");
  assert.equal(store.get("msg_4")?.status, "completed");
});

test("deliver completion store restores snapshot after restart", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "adjutant-deliver-completion-"));
  t.after(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  const store1 = DeliverCompletionStore.fromStateDir(stateDir);
  await store1.initialize();
  store1.apply({
    messageId: "msg_snapshot_1",
    status: "completed",
    finishedAt: "2026-03-04T01:00:00.000Z",
  });
  await store1.persist();

  const store2 = DeliverCompletionStore.fromStateDir(stateDir);
  await store2.initialize();
  assert.equal(store2.get("msg_snapshot_1")?.status, "completed");
});
