import assert from "node:assert/strict";
import test from "node:test";

import { DomCaptureService } from "../../../src/collector-slack/dom-capture-service.js";

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

test("capture 成功後に consume で text/channel を取得できる", async () => {
  const calls: Array<number | null> = [];
  const cached: Array<{ channelId: string; ts: string; text: string }> = [];

  const service = new DomCaptureService({
    disabled: false,
    debugDetailed: false,
    resolveContextIds: () => [1, null],
    evaluateInContext: async (_expression, contextId) => {
      calls.push(contextId);
      if (contextId === 1) {
        return { status: "no-target" };
      }
      return {
        text: "hello from dom",
        channel: "general",
        channelId: "C123",
        matchedTs: ["1711112222.000300"],
      };
    },
    normalizedTimestamp: (ts) => ts ?? null,
    toText: asString,
    debugLog: () => {},
    resolveChannelName: () => undefined,
    cacheMessage: (channelId, ts, value) => {
      cached.push({ channelId, ts, text: value.text });
    },
    sleep: async () => {},
  });

  await service.capture({
    channelId: "C123",
    frameId: "F1",
    ts: "1711112222.000300",
    normalizedTs: "1711112222.000300",
  });

  const consumed = service.consume("1711112222.000300");
  assert.deepEqual(consumed, {
    text: "hello from dom",
    channelName: "general",
    channelId: "C123",
  });
  assert.deepEqual(calls, [1, null]);
  assert.deepEqual(cached, [
    { channelId: "C123", ts: "1711112222.000300", text: "hello from dom" },
  ]);
});

test("capture 失敗時は consume が null を返し debugDetailed なら失敗ログを残す", async () => {
  const logs: Array<{ message: string; payload?: unknown }> = [];

  const service = new DomCaptureService({
    disabled: false,
    debugDetailed: true,
    resolveContextIds: () => [7, null],
    evaluateInContext: async () => ({ status: "no-target", sampleTs: ["171"] }),
    normalizedTimestamp: (ts) => ts ?? null,
    toText: asString,
    debugLog: (message, payload) => {
      logs.push({ message, payload });
    },
    resolveChannelName: () => undefined,
    cacheMessage: () => {},
    sleep: async () => {},
  });

  await service.capture({
    channelId: "C999",
    ts: "1711112222.000999",
    normalizedTs: "1711112222.000999",
  });

  assert.equal(service.consume("1711112222.000999"), null);
  assert.equal(
    logs.some((entry) => entry.message === "dom capture failure"),
    true
  );
});
