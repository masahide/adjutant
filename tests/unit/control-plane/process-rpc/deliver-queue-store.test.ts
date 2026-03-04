import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { DeliverEnqueueRequest } from "../../../../src/contracts/process-rpc/method-types.js";
import { DeliverQueueStore } from "../../../../src/control-plane/process-rpc/deliver-queue-store.js";

function createRequest(index: number): DeliverEnqueueRequest {
  return {
    messageId: `msg_deliver_${index}`,
    dedupeKey: `deliver:msg_deliver_${index}`,
    target: "slack",
    payload: {
      text: `done-${index}`,
    },
    attempt: 1,
    maxAttempts: 3,
  };
}

test("DeliverQueueStore append/replay/commit は cursor に従って再生できる", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "adjutant-deliver-queue-store-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const store = DeliverQueueStore.fromStateDir(root, {
    now: () => "2026-03-04T00:10:00.000Z",
  });
  await store.initialize();

  const cursor0 = await store.append({
    request: createRequest(1),
  });
  const cursor1 = await store.append({
    request: createRequest(2),
  });

  assert.deepEqual(cursor0, { segment: 0, offset: 0 });
  assert.deepEqual(cursor1, { segment: 0, offset: 1 });

  const firstReplay = await store.replayPending();
  assert.equal(firstReplay.length, 2);
  assert.equal(firstReplay[0]?.value.request.messageId, "msg_deliver_1");
  assert.equal(firstReplay[1]?.value.request.messageId, "msg_deliver_2");
  assert.equal(firstReplay[0]?.value.enqueuedAt, "2026-03-04T00:10:00.000Z");
  assert.equal(firstReplay[0]?.value.state, "pending");

  await store.commitThrough(cursor0);
  assert.deepEqual(store.currentCursor(), { segment: 0, offset: 1 });

  const secondReplay = await store.replayPending();
  assert.equal(secondReplay.length, 1);
  assert.equal(secondReplay[0]?.value.request.messageId, "msg_deliver_2");
  assert.deepEqual(secondReplay[0]?.cursor, { segment: 0, offset: 1 });

  const restored = DeliverQueueStore.fromStateDir(root);
  await restored.initialize();
  assert.deepEqual(restored.currentCursor(), { segment: 0, offset: 1 });
  const restoredReplay = await restored.replayPending();
  assert.equal(restoredReplay.length, 1);
  assert.equal(restoredReplay[0]?.value.request.messageId, "msg_deliver_2");
});

test("DeliverQueueStore commitThrough は単調増加のみ反映する", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "adjutant-deliver-queue-cursor-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const store = DeliverQueueStore.fromStateDir(root);
  await store.initialize();

  const cursor0 = await store.append({
    request: createRequest(1),
  });
  const cursor1 = await store.append({
    request: createRequest(2),
  });

  await store.commitThrough(cursor1);
  await store.commitThrough(cursor0);
  assert.deepEqual(store.currentCursor(), { segment: 0, offset: 2 });

  const cursorPath = join(root, "cursor", "control-plane.deliver-queue.json");
  const raw = await readFile(cursorPath, "utf8");
  assert.equal(raw.includes('"offset":2'), true);
});
