import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createBatchClassifier } from "../../src/proactive/batch-classifier.js";
import type { NormalizedEvent } from "../../src/core/events.js";

function createEvent(uid: string, text = "hello"): NormalizedEvent {
  return {
    schema: "adjutant.event.v1.1",
    uid,
    source: "slack",
    kind: "post",
    ts: "2026-02-22T10:30:00.000Z",
    actor: "U123",
    detail: {
      slack: {
        channel_id: "C123",
        text,
      },
    },
  };
}

describe("batch-classifier", () => {
  it("ツール出力を parse できる", async () => {
    const classifier = createBatchClassifier({
      classifyChunk: async () => ({
        action: "respond",
        confidence: 0.9,
        reason: "needs-response",
      }),
      confidenceThreshold: 0.7,
    });
    const result = await classifier.classify({
      sessionKey: "slack:channel:C123",
      events: [createEvent("uid-1")],
    });
    assert.equal(result.action, "respond");
  });

  it("confidence が閾値未満なら fail-closed で note にする", async () => {
    const classifier = createBatchClassifier({
      classifyChunk: async () => ({
        action: "respond",
        confidence: 0.5,
        reason: "uncertain",
      }),
      confidenceThreshold: 0.7,
    });
    const result = await classifier.classify({
      sessionKey: "slack:channel:C123",
      events: [createEvent("uid-1")],
    });
    assert.equal(result.action, "note");
  });

  it("timeout は fail-closed で note にする", async () => {
    const classifier = createBatchClassifier({
      classifyChunk: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return {
          action: "respond",
          confidence: 1,
          reason: "late",
        };
      },
      timeoutMs: 5,
    });
    const result = await classifier.classify({
      sessionKey: "slack:channel:C123",
      events: [createEvent("uid-1")],
    });
    assert.equal(result.action, "note");
  });

  it("classifyChunk へ渡す prompt はチャンク内の全イベント本文を含む", async () => {
    let receivedPrompt = "";
    const classifier = createBatchClassifier({
      classifyChunk: async ({ prompt }) => {
        receivedPrompt = prompt;
        return {
          action: "respond",
          confidence: 0.9,
          reason: "ok",
        };
      },
    });
    await classifier.classify({
      sessionKey: "slack:channel:C123",
      events: [createEvent("uid-1", "first text"), createEvent("uid-2", "second text")],
    });
    assert.equal(receivedPrompt.includes("first text"), true);
    assert.equal(receivedPrompt.includes("second text"), true);
  });
});
