import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  DebugEventHub,
  handleDebugUiRequest,
  type HttpLikeRequest,
  type HttpLikeResponse,
} from "../../../src/collector-slack/debug-ui.js";

class FakeRequest extends EventEmitter implements HttpLikeRequest {
  constructor(
    public method: string,
    public url: string
  ) {
    super();
  }
}

class FakeResponse implements HttpLikeResponse {
  statusCode = 0;
  headers = new Map<string, string>();
  writes: string[] = [];
  ended = false;

  setHeader(name: string, value: string): void {
    this.headers.set(name.toLowerCase(), value);
  }

  write(chunk: string): void {
    this.writes.push(chunk);
  }

  end(chunk?: string): void {
    if (chunk !== undefined) {
      this.writes.push(chunk);
    }
    this.ended = true;
  }
}

test("GET /events は debug SSE を継続配信し close で購読解除される", () => {
  const hub = new DebugEventHub();
  const req = new FakeRequest("GET", "/events");
  const res = new FakeResponse();

  const handled = handleDebugUiRequest(req, res, hub);
  assert.equal(handled, true);
  assert.equal(hub.listenerCount(), 1);
  assert.equal(res.headers.get("content-type"), "text/event-stream; charset=utf-8");
  assert.ok(res.writes[0]?.includes("retry: 1000"));

  hub.publish({
    source: "slack-adapter",
    kind: "normalized",
    at: "2026-03-03T12:00:00.000Z",
    payload: { uid: "slack:C123@1" },
  });
  assert.ok(res.writes.some((line) => line.includes("event: debug")));

  req.emit("close");
  assert.equal(hub.listenerCount(), 0);
  assert.equal(res.ended, true);
});

test("GET /health は 200 JSON を返す", () => {
  const hub = new DebugEventHub();
  const req = new FakeRequest("GET", "/health");
  const res = new FakeResponse();

  const handled = handleDebugUiRequest(req, res, hub);
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
  assert.ok(res.writes.join("").includes('"status":"ok"'));
});
