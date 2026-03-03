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
      payload: {
        schema: "adjutant.event.v1.1",
        uid: "slack:C123@1740738800.123",
        source: "slack",
        kind: "post",
        ts: "2026-02-28T12:00:00.000Z",
        detail: {
          slack: {
            channel_id: "C123",
            message_ts: "1740738800.123",
            text: "hello",
          },
        },
      },
      occurredAt: "2026-02-28T12:00:00.000Z",
    },
  };

  assert.equal(validateProcessRpcRequest(request), true);
});

test("validateProcessRpcRequest rejects collector/ingest when source is not slack", () => {
  const request = {
    jsonrpc: "2.0",
    id: "ing_02",
    method: "collector/ingest",
    params: {
      messageId: "msg_02",
      dedupeKey: "slack:C123:1740738800.124",
      source: "github",
      payload: {
        schema: "adjutant.event.v1.1",
        uid: "slack:C123@1740738800.124",
        source: "slack",
        kind: "post",
        ts: "2026-02-28T12:00:01.000Z",
      },
      occurredAt: "2026-02-28T12:00:01.000Z",
    },
  };

  assert.equal(validateProcessRpcRequest(request), false);
});

test("validateProcessRpcRequest rejects collector/ingest with malformed payload", () => {
  const request = {
    jsonrpc: "2.0",
    id: "ing_03",
    method: "collector/ingest",
    params: {
      messageId: "msg_03",
      dedupeKey: "slack:C123:1740738800.125",
      source: "slack",
      payload: {
        uid: "slack:C123@1740738800.125",
        source: "slack",
        kind: "post",
        ts: "2026-02-28T12:00:02.000Z",
      },
      occurredAt: "2026-02-28T12:00:02.000Z",
    },
  };

  assert.equal(validateProcessRpcRequest(request), false);
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
