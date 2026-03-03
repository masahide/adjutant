import assert from "node:assert/strict";
import test from "node:test";

import { DomCaptureService } from "../../../src/collector-slack/dom-capture-service.js";

test("同一 ts の並列 capture は 1 回だけ evaluate される", async () => {
  let evaluateCount = 0;
  const service = new DomCaptureService({
    disabled: false,
    debugDetailed: false,
    resolveContextIds: () => [null],
    evaluateInContext: async () => {
      evaluateCount += 1;
      return {
        text: "parallel-safe",
        channelName: "general",
        channelId: "C123",
      };
    },
    normalizedTimestamp: (ts) => ts ?? null,
    toText: (value) => (typeof value === "string" ? value : undefined),
    debugLog: () => {},
    resolveChannelName: () => undefined,
    cacheMessage: () => {},
    sleep: async () => {},
  });

  await Promise.all([
    service.capture({
      channelId: "C123",
      ts: "1711112222.000300",
      normalizedTs: "1711112222.000300",
    }),
    service.capture({
      channelId: "C123",
      ts: "1711112222.000300",
      normalizedTs: "1711112222.000300",
    }),
  ]);

  assert.equal(evaluateCount, 1);
  assert.deepEqual(service.consume("1711112222.000300"), {
    text: "parallel-safe",
    channelName: "general",
    channelId: "C123",
  });
});
