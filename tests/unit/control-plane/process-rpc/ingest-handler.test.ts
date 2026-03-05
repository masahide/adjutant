import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { CollectorIngestRequest } from "../../../../src/contracts/process-rpc/method-types.js";
import { IdempotencyStore } from "../../../../src/control-plane/idempotency-store.js";
import {
  CollectorIngestHandler,
  IngestValidationError,
} from "../../../../src/control-plane/process-rpc/ingest-handler.js";

function createRequest(overrides: Partial<CollectorIngestRequest> = {}): CollectorIngestRequest {
  return {
    messageId: overrides.messageId ?? "msg_1",
    dedupeKey: overrides.dedupeKey ?? "slack:C123@1730000000.123",
    source: "slack",
    occurredAt: overrides.occurredAt ?? "2026-03-03T12:00:00.000Z",
    payload: overrides.payload ?? {
      schema: "adjutant.event.v1.1",
      uid: "slack:C123@1730000000.123",
      source: "slack",
      kind: "post",
      ts: "2026-03-03T12:00:00.000Z",
      detail: {
        slack: {
          channel_id: "C123",
          message_ts: "1730000000.123",
          text: "hello",
        },
      },
    },
  };
}

test("accept: 正常リクエストを受理し onAccept を呼ぶ", async () => {
  const accepted: string[] = [];
  const handler = new CollectorIngestHandler({
    now: () => new Date("2026-03-03T12:34:56.000Z"),
    onAccept: async (projection) => {
      accepted.push(projection.sessionKey);
    },
  });

  const response = await handler.accept(createRequest());
  assert.equal(response.status, "accepted");
  assert.equal(response.messageId, "msg_1");
  assert.equal(response.acceptedAt, "2026-03-03T12:34:56.000Z");
  assert.deepEqual(accepted, ["slack:channel:C123"]);
});

test("accept: 同一 dedupeKey + 同一 payload は canonical messageId で冪等受理", async () => {
  let acceptCount = 0;
  const handler = new CollectorIngestHandler({
    onAccept: async () => {
      acceptCount += 1;
    },
  });

  const first = await handler.accept(createRequest({ messageId: "msg_first" }));
  const second = await handler.accept(createRequest({ messageId: "msg_retry" }));

  assert.equal(first.messageId, "msg_first");
  assert.equal(second.messageId, "msg_first");
  assert.equal(acceptCount, 1);
});

test("accept: 同一 dedupeKey + 異なる payload は INVALID_REQUEST", async () => {
  const handler = new CollectorIngestHandler();
  await handler.accept(createRequest({ messageId: "msg_first" }));

  await assert.rejects(
    () =>
      handler.accept(
        createRequest({
          messageId: "msg_conflict",
          payload: {
            schema: "adjutant.event.v1.1",
            uid: "slack:C123@1730000000.999",
            source: "slack",
            kind: "post",
            ts: "2026-03-03T12:00:00.000Z",
            detail: {
              slack: { channel_id: "C123", message_ts: "1730000000.999", text: "changed" },
            },
          },
        })
      ),
    (error: unknown) =>
      error instanceof IngestValidationError &&
      /same dedupeKey with different payload/.test(error.message)
  );
});

test("accept: 不正な params は INVALID_REQUEST", async () => {
  const handler = new CollectorIngestHandler();
  await assert.rejects(
    () =>
      handler.accept({
        messageId: "msg_1",
        dedupeKey: "dedupe_1",
        source: "github",
      }),
    (error: unknown) =>
      error instanceof IngestValidationError && /params are invalid/.test(error.message)
  );
});

test("accept: restart 後も dedupeKey の canonical messageId を維持する", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "adjutant-ingest-idempotency-"));
  t.after(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  const store1 = IdempotencyStore.fromStateDir(stateDir);
  await store1.initialize();

  const handler1 = new CollectorIngestHandler({
    idempotencyStore: store1,
  });
  const first = await handler1.accept(
    createRequest({
      messageId: "msg_ingest_first",
      dedupeKey: "slack:C123@1730000000.456",
    })
  );
  assert.equal(first.messageId, "msg_ingest_first");

  const store2 = IdempotencyStore.fromStateDir(stateDir);
  await store2.initialize();
  const handler2 = new CollectorIngestHandler({
    idempotencyStore: store2,
  });

  const duplicate = await handler2.accept(
    createRequest({
      messageId: "msg_ingest_retry",
      dedupeKey: "slack:C123@1730000000.456",
    })
  );
  assert.equal(duplicate.messageId, "msg_ingest_first");

  await assert.rejects(
    () =>
      handler2.accept(
        createRequest({
          messageId: "msg_ingest_conflict",
          dedupeKey: "slack:C123@1730000000.456",
          payload: {
            schema: "adjutant.event.v1.1",
            uid: "slack:C123@1730000000.456",
            source: "slack",
            kind: "post",
            ts: "2026-03-03T12:00:00.000Z",
            detail: {
              slack: {
                channel_id: "C123",
                message_ts: "1730000000.456",
                text: "changed after restart",
              },
            },
          },
        })
      ),
    (error: unknown) =>
      error instanceof IngestValidationError &&
      /same dedupeKey with different payload/.test(error.message)
  );
});
