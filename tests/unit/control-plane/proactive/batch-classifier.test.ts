import assert from "node:assert/strict";
import test from "node:test";

import { createBatchClassifier } from "../../../../src/control-plane/proactive/batch-classifier.js";
import type { NormalizedEvent } from "../../../../src/core/events.js";

function sampleEvent(): NormalizedEvent {
  return {
    schema: "adjutant.event.v1.1",
    uid: "slack:C111@1730000000.100",
    source: "slack",
    kind: "post",
    ts: "2026-03-05T00:00:00.000Z",
    detail: {
      slack: {
        channel_id: "C111",
        message_ts: "1730000000.100",
        text: "hello",
      },
    },
  };
}

test("classifier timeout は fail-closed で note になる", async () => {
  const classifier = createBatchClassifier({
    timeoutMs: 20,
    classifyChunk: async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { action: "respond", confidence: 1, reason: "late" };
    },
  });

  const decision = await classifier.classify({
    sessionKey: "slack:channel:C111",
    events: [sampleEvent()],
  });
  assert.equal(decision.action, "note");
  assert.equal(decision.reason, "classifier-fail-closed");
});

test("confidence が閾値未満なら note になる", async () => {
  const classifier = createBatchClassifier({
    confidenceThreshold: 0.7,
    classifyChunk: async () => {
      return { action: "respond", confidence: 0.2, reason: "low confidence" };
    },
  });

  const decision = await classifier.classify({
    sessionKey: "slack:channel:C111",
    events: [sampleEvent()],
  });
  assert.equal(decision.action, "note");
  assert.equal(decision.reason, "low-confidence-fail-closed");
});

test("有効な分類結果はそのまま通す", async () => {
  const classifier = createBatchClassifier({
    classifyChunk: async () => {
      return { action: "respond", confidence: 1, reason: "ok" };
    },
  });

  const decision = await classifier.classify({
    sessionKey: "slack:channel:C111",
    events: [sampleEvent()],
  });
  assert.equal(decision.action, "respond");
  assert.equal(decision.reason, "ok");
});
