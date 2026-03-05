import assert from "node:assert/strict";
import test from "node:test";

import type {
  DeliverCompletedNotification,
  DeliverEnqueueRequest,
} from "../../../../src/contracts/process-rpc/method-types.js";
import { DeliverCompletionStore } from "../../../../src/control-plane/deliver-completion-store.js";
import { DeliverQueueCoordinator } from "../../../../src/control-plane/process-rpc/deliver-queue-coordinator.js";
import type { DeliverQueueEntry } from "../../../../src/control-plane/process-rpc/deliver-queue-store.js";
import type { Cursor } from "../../../../src/runtime/journal-store.js";

function createRequest(messageId: string): DeliverEnqueueRequest {
  return {
    messageId,
    dedupeKey: `deliver:${messageId}`,
    target: "slack",
    payload: {
      text: "done",
    },
    attempt: 1,
    maxAttempts: 3,
  };
}

test("DeliverQueueCoordinator は enqueue accepted と completion commit を連携する", async () => {
  const appended: Array<{ cursor: Cursor; entry: DeliverQueueEntry }> = [];
  const committed: Cursor[] = [];
  const completionStore = new DeliverCompletionStore();
  const dispatched: DeliverEnqueueRequest[] = [];
  const queueStore = {
    async append(input: { request: DeliverEnqueueRequest }): Promise<Cursor> {
      const cursor: Cursor = { segment: 0, offset: appended.length };
      appended.push({
        cursor,
        entry: {
          version: 1,
          enqueuedAt: "2026-03-04T00:00:00.000Z",
          request: input.request,
          nextAttemptAt: "2026-03-04T00:00:00.000Z",
          state: "pending",
        },
      });
      return cursor;
    },
    async commitThrough(cursor: Cursor): Promise<void> {
      committed.push(cursor);
    },
  };

  const coordinator = new DeliverQueueCoordinator({
    queueStore,
    completionStore,
    resolveDispatcher: () => ({
      enqueue: async (request) => {
        dispatched.push(request);
      },
    }),
    dispatchTimeoutMs: 1_000,
  });

  const request = createRequest("msg_queue_coordinator_1");
  const accepted = await coordinator.accept(request);

  assert.deepEqual(accepted.cursor, { segment: 0, offset: 0 });
  assert.equal(accepted.dispatchStatus, "accepted");
  assert.equal(dispatched.length, 1);
  assert.equal(appended.length, 1);

  const completion: DeliverCompletedNotification = {
    messageId: request.messageId,
    status: "completed",
    finishedAt: "2026-03-04T00:00:01.000Z",
  };
  const result = await coordinator.applyCompletion(completion);
  assert.equal(result.applied.applied, true);
  assert.equal(result.cursorCommitted, true);
  assert.deepEqual(committed, [{ segment: 0, offset: 0 }]);
});

test("DeliverQueueCoordinator は dispatcher 不在時に skipped を返し未知 completion を commit しない", async () => {
  const completionStore = new DeliverCompletionStore();
  const queueStore = {
    async append(_input: { request: DeliverEnqueueRequest }): Promise<Cursor> {
      return { segment: 0, offset: 0 };
    },
    async commitThrough(): Promise<void> {
      throw new Error("UNEXPECTED_COMMIT");
    },
  };

  const coordinator = new DeliverQueueCoordinator({
    queueStore,
    completionStore,
  });

  const request = createRequest("msg_queue_coordinator_2");
  const accepted = await coordinator.accept(request);
  assert.equal(accepted.dispatchStatus, "skipped");

  const result = await coordinator.applyCompletion({
    messageId: "msg_unknown",
    status: "completed",
    finishedAt: "2026-03-04T00:00:01.000Z",
  });
  assert.equal(result.cursorCommitted, false);
});
