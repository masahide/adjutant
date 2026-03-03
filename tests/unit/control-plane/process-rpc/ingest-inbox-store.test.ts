import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { CollectorIngestRequest } from "../../../../src/contracts/process-rpc/method-types.js";
import { IngestInboxStore } from "../../../../src/control-plane/process-rpc/ingest-inbox-store.js";
import type { IngestProjection } from "../../../../src/control-plane/process-rpc/ingest-projection.js";

function createRequest(index: number): CollectorIngestRequest {
  return {
    messageId: `msg_${index}`,
    dedupeKey: `slack:C123@1730000000.${index}`,
    source: "slack",
    occurredAt: `2026-03-03T12:00:0${index}.000Z`,
    payload: {
      schema: "adjutant.event.v1.1",
      uid: `slack:C123@1730000000.${index}`,
      source: "slack",
      kind: "post",
      ts: `2026-03-03T12:00:0${index}.000Z`,
      detail: {
        slack: {
          channel_id: "C123",
          message_ts: `1730000000.${index}`,
          text: `hello-${index}`,
        },
      },
    },
  };
}

function createProjection(index: number): IngestProjection {
  const request = createRequest(index);
  return {
    sessionKey: "slack:channel:C123",
    message: `[Slack post] channel=C123 text=hello-${index}`,
    dedupeKey: request.dedupeKey,
    source: "slack",
    occurredAt: request.occurredAt,
    rawEvent: request.payload,
  };
}

test("IngestInboxStore append/replay/commit は cursor に従って再生できる", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "adjutant-ingest-inbox-store-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const store = IngestInboxStore.fromStateDir(root, {
    now: () => "2026-03-03T12:34:56.000Z",
  });
  await store.initialize();

  const cursor0 = await store.append({
    request: createRequest(1),
    projection: createProjection(1),
  });
  const cursor1 = await store.append({
    request: createRequest(2),
    projection: createProjection(2),
  });

  assert.deepEqual(cursor0, { segment: 0, offset: 0 });
  assert.deepEqual(cursor1, { segment: 0, offset: 1 });

  const firstReplay = await store.replayPending();
  assert.equal(firstReplay.length, 2);
  assert.equal(firstReplay[0]?.value.request.messageId, "msg_1");
  assert.equal(firstReplay[1]?.value.request.messageId, "msg_2");
  assert.equal(firstReplay[0]?.value.receivedAt, "2026-03-03T12:34:56.000Z");

  await store.commitThrough(cursor0);
  assert.deepEqual(store.currentCursor(), { segment: 0, offset: 1 });

  const secondReplay = await store.replayPending();
  assert.equal(secondReplay.length, 1);
  assert.equal(secondReplay[0]?.value.request.messageId, "msg_2");
  assert.deepEqual(secondReplay[0]?.cursor, { segment: 0, offset: 1 });

  const restored = IngestInboxStore.fromStateDir(root);
  await restored.initialize();
  assert.deepEqual(restored.currentCursor(), { segment: 0, offset: 1 });
  const restoredReplay = await restored.replayPending();
  assert.equal(restoredReplay.length, 1);
  assert.equal(restoredReplay[0]?.value.request.messageId, "msg_2");
});

test("IngestInboxStore commitThrough は単調増加のみ反映する", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "adjutant-ingest-inbox-cursor-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const store = IngestInboxStore.fromStateDir(root);
  await store.initialize();

  const cursor0 = await store.append({
    request: createRequest(1),
    projection: createProjection(1),
  });
  const cursor1 = await store.append({
    request: createRequest(2),
    projection: createProjection(2),
  });

  await store.commitThrough(cursor1);
  await store.commitThrough(cursor0);
  assert.deepEqual(store.currentCursor(), { segment: 0, offset: 2 });

  const cursorPath = join(root, "cursor", "control-plane.inbox.json");
  const raw = await readFile(cursorPath, "utf8");
  assert.equal(raw.includes('"offset":2'), true);
});
