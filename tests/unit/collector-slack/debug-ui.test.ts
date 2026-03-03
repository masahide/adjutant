import assert from "node:assert/strict";
import test from "node:test";

import { DebugEventHub, toSseDebugFrame } from "../../../src/collector-slack/debug-ui.js";

test("DebugEventHub は subscribe/unsubscribe で debug イベントを配信できる", () => {
  const hub = new DebugEventHub();
  const received: string[] = [];
  const detach = hub.subscribe((event) => {
    received.push(event.kind);
  });

  hub.publish({
    source: "slack-adapter",
    kind: "raw_fetch",
    at: "2026-03-03T12:00:00.000Z",
    payload: { ok: true },
  });
  assert.deepEqual(received, ["raw_fetch"]);
  assert.equal(hub.listenerCount(), 1);

  detach();
  hub.publish({
    source: "slack-adapter",
    kind: "normalized",
    at: "2026-03-03T12:00:01.000Z",
    payload: {},
  });
  assert.deepEqual(received, ["raw_fetch"]);
  assert.equal(hub.listenerCount(), 0);
});

test("toSseDebugFrame は debug SSE 形式でシリアライズする", () => {
  const frame = toSseDebugFrame({
    source: "slack-adapter",
    kind: "raw_ws",
    at: "2026-03-03T12:00:00.000Z",
    payload: { key: "value" },
  });

  assert.match(frame, /^event: debug\n/);
  assert.match(frame, /\ndata: /);
  assert.match(frame, /\n\n$/);
});
