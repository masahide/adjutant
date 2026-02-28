import assert from "node:assert/strict";
import test from "node:test";

import {
  validateDeliverCompletedNotification,
  validateProcessRpcNotification,
  validateProcessRpcRequest,
} from "../../../src/contracts/process-rpc/rpc-types.js";

test("validateProcessRpcRequest accepts collector/ingest envelope", () => {
  const request = {
    jsonrpc: "2.0",
    id: "ing_01",
    method: "collector/ingest",
    params: {
      messageId: "msg_01",
      dedupeKey: "slack:C123:1740738800.123",
      source: "slack",
      payload: { text: "hello" },
      occurredAt: "2026-02-28T12:00:00.000Z",
    },
  };

  assert.equal(validateProcessRpcRequest(request), true);
});

test("validateProcessRpcRequest rejects malformed deliver/enqueue envelope", () => {
  const request = {
    jsonrpc: "2.0",
    id: 10,
    method: "deliver/enqueue",
    params: {
      messageId: "msg_01",
      dedupeKey: "deliver:msg_01",
      target: "slack",
      payload: {},
      attempt: "1",
      maxAttempts: 3,
    },
  };

  assert.equal(validateProcessRpcRequest(request), false);
});

test("validateProcessRpcNotification accepts deliver/completed notification", () => {
  const notification = {
    jsonrpc: "2.0",
    method: "deliver/completed",
    params: {
      messageId: "msg_01",
      status: "completed",
      finishedAt: "2026-02-28T12:00:02.000Z",
    },
  };

  assert.equal(validateProcessRpcNotification(notification), true);
  assert.equal(validateDeliverCompletedNotification(notification.params), true);
});
