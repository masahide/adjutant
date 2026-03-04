import assert from "node:assert/strict";
import test from "node:test";

import { DeliverEnqueueHandler } from "../../../../src/control-plane/process-rpc/deliver-handler.js";
import { CollectorIngestHandler } from "../../../../src/control-plane/process-rpc/ingest-handler.js";
import {
  ProcessRpcServer,
  parseJsonRpcRequestLine,
} from "../../../../src/control-plane/process-rpc/server.js";

function validIngestEnvelope() {
  return {
    jsonrpc: "2.0",
    id: "ing_1",
    method: "collector/ingest",
    params: {
      messageId: "msg_1",
      dedupeKey: "slack:C123@1730000000.123",
      source: "slack",
      occurredAt: "2026-03-03T12:00:00.000Z",
      payload: {
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
    },
  };
}

test("ProcessRpcServer: collector/ingest を accepted で返す", async () => {
  const server = new ProcessRpcServer({
    ingestHandler: new CollectorIngestHandler({
      now: () => new Date("2026-03-03T12:00:00.000Z"),
    }),
  });

  const response = await server.handleRequest(validIngestEnvelope());
  assert.equal("result" in response, true);
  if ("result" in response) {
    assert.equal(response.result.status, "accepted");
    assert.equal(response.result.messageId, "msg_1");
  }
});

test("ProcessRpcServer: malformed envelope は INVALID_REQUEST", async () => {
  const server = new ProcessRpcServer({
    ingestHandler: new CollectorIngestHandler(),
  });

  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: "ing_1",
    method: "collector/ingest",
    params: {
      messageId: "msg_1",
      source: "github",
    },
  });

  assert.equal("error" in response, true);
  if ("error" in response) {
    assert.equal(response.error.message, "INVALID_REQUEST");
  }
});

test("ProcessRpcServer: deliver handler 未設定時の deliver/enqueue は METHOD_NOT_SUPPORTED", async () => {
  const server = new ProcessRpcServer({
    ingestHandler: new CollectorIngestHandler(),
  });

  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: "del_1",
    method: "deliver/enqueue",
    params: {
      messageId: "m1",
      dedupeKey: "d1",
      target: "slack",
      payload: {},
      attempt: 1,
      maxAttempts: 3,
    },
  });

  assert.equal("error" in response, true);
  if ("error" in response) {
    assert.equal(response.error.message, "METHOD_NOT_SUPPORTED");
  }
});

test("ProcessRpcServer: deliver/enqueue を accepted で返す", async () => {
  const server = new ProcessRpcServer({
    ingestHandler: new CollectorIngestHandler(),
    deliverHandler: new DeliverEnqueueHandler({
      now: () => new Date("2026-03-04T00:00:00.000Z"),
    }),
  });

  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: "del_2",
    method: "deliver/enqueue",
    params: {
      messageId: "m2",
      dedupeKey: "d2",
      target: "slack",
      payload: { text: "hello" },
      attempt: 1,
      maxAttempts: 3,
    },
  });

  assert.equal("result" in response, true);
  if ("result" in response) {
    assert.equal(response.result.status, "accepted");
    assert.equal(response.result.messageId, "m2");
    assert.equal(response.result.acceptedAt, "2026-03-04T00:00:00.000Z");
  }
});

test("ProcessRpcServer: deliver/enqueue の attempt 不正は INVALID_REQUEST", async () => {
  const server = new ProcessRpcServer({
    ingestHandler: new CollectorIngestHandler(),
    deliverHandler: new DeliverEnqueueHandler(),
  });

  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: "del_3",
    method: "deliver/enqueue",
    params: {
      messageId: "m3",
      dedupeKey: "d3",
      target: "slack",
      payload: {},
      attempt: 0,
      maxAttempts: 3,
    },
  });

  assert.equal("error" in response, true);
  if ("error" in response) {
    assert.equal(response.error.message, "INVALID_REQUEST");
  }
});

test("parseJsonRpcRequestLine: JSON parse error を返す", () => {
  const parsed = parseJsonRpcRequestLine("{invalid");
  assert.equal("error" in parsed, true);
  if ("error" in parsed) {
    assert.equal(parsed.error.message, "PARSE_ERROR");
  }
});
