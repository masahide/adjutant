import assert from "node:assert/strict";
import test from "node:test";

import { createBatchClassifier } from "../../../../src/control-plane/proactive/batch-classifier.js";
import { createProactiveIngressService } from "../../../../src/control-plane/proactive/ingress-service.js";
import type { NormalizedEvent } from "../../../../src/core/events.js";

function createChannelEvent(uid: string, text: string): NormalizedEvent {
  return {
    schema: "adjutant.event.v1.1",
    uid,
    source: "slack",
    kind: "post",
    ts: "2026-03-05T00:00:00.000Z",
    detail: {
      slack: {
        channel_id: "C111",
        message_ts: uid.split("@")[1] ?? "1730000000.100",
        text,
      },
    },
  };
}

test("channel は attention window で集約されて 1 dispatch になる", async () => {
  const dispatched: Array<{ source: string; count: number }> = [];
  const service = createProactiveIngressService<{ id: string }>({
    attentionWindowConfig: {
      channelIdleMs: 20,
      channelMaxWaitMs: 200,
    },
    batchClassifier: createBatchClassifier({
      classifyChunk: async () => ({ action: "respond", confidence: 1, reason: "ok" }),
    }),
    dispatch: async (input) => {
      dispatched.push({
        source: input.source,
        count: input.items.length,
      });
    },
  });

  await service.ingest({
    sessionKey: "slack:channel:C111",
    event: createChannelEvent("slack:C111@1730000000.100", "one"),
    payload: { id: "1" },
  });
  await service.ingest({
    sessionKey: "slack:channel:C111",
    event: createChannelEvent("slack:C111@1730000000.101", "two"),
    payload: { id: "2" },
  });

  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0]?.source, "channel");
  assert.equal(dispatched[0]?.count, 2);
});

test("classifier 失敗時は fail-closed note となり dispatch しない", async () => {
  const dispatched: string[] = [];
  const notes: string[] = [];
  const service = createProactiveIngressService<{ id: string }>({
    attentionWindowConfig: {
      channelIdleMs: 20,
      channelMaxWaitMs: 200,
    },
    batchClassifier: createBatchClassifier({
      classifyChunk: async () => {
        throw new Error("classifier boom");
      },
    }),
    onSystemEvent: (event) => {
      notes.push(event.reason);
    },
    dispatch: async () => {
      dispatched.push("called");
    },
  });

  await service.ingest({
    sessionKey: "slack:channel:C111",
    event: createChannelEvent("slack:C111@1730000000.102", "fail closed"),
    payload: { id: "1" },
  });

  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(dispatched.length, 0);
  assert.equal(notes.length, 1);
  assert.equal(notes[0], "classifier-fail-closed");
});
