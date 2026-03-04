import assert from "node:assert/strict";
import test from "node:test";

import {
  DeliverEnqueueHandler,
  DeliverValidationError,
} from "../../../../src/control-plane/process-rpc/deliver-handler.js";

test("DeliverEnqueueHandler: 有効な request を accepted で返す", async () => {
  let acceptedMessageId: string | undefined;
  const handler = new DeliverEnqueueHandler({
    now: () => new Date("2026-03-04T00:01:00.000Z"),
    onAccept: (request) => {
      acceptedMessageId = request.messageId;
    },
  });

  const accepted = await handler.accept({
    messageId: "msg_deliver_1",
    dedupeKey: "deliver:msg_deliver_1",
    target: "slack",
    payload: { text: "done" },
    attempt: 1,
    maxAttempts: 3,
  });

  assert.equal(accepted.messageId, "msg_deliver_1");
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.acceptedAt, "2026-03-04T00:01:00.000Z");
  assert.equal(acceptedMessageId, "msg_deliver_1");
});

test("DeliverEnqueueHandler: attempt が maxAttempts を超えると DeliverValidationError", async () => {
  const handler = new DeliverEnqueueHandler();
  await assert.rejects(
    () =>
      handler.accept({
        messageId: "msg_deliver_2",
        dedupeKey: "deliver:msg_deliver_2",
        target: "slack",
        payload: {},
        attempt: 4,
        maxAttempts: 3,
      }),
    (error: unknown) =>
      error instanceof DeliverValidationError &&
      error.message === "attempt must be less than or equal to maxAttempts"
  );
});

test("DeliverEnqueueHandler: attempt が整数でないと DeliverValidationError", async () => {
  const handler = new DeliverEnqueueHandler();
  await assert.rejects(
    () =>
      handler.accept({
        messageId: "msg_deliver_3",
        dedupeKey: "deliver:msg_deliver_3",
        target: "slack",
        payload: {},
        attempt: 1.5,
        maxAttempts: 3,
      }),
    (error: unknown) =>
      error instanceof DeliverValidationError &&
      error.message === "attempt must be a positive integer"
  );
});
