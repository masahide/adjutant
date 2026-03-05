import assert from "node:assert/strict";
import test from "node:test";

import { createBatchClassifier } from "../../../src/control-plane/proactive/batch-classifier.js";
import { createProactiveIngressService } from "../../../src/control-plane/proactive/ingress-service.js";
import type { NormalizedEvent } from "../../../src/core/events.js";

function event(): NormalizedEvent {
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
        text: "contract",
      },
    },
  };
}

test("classifier action contract: non-respond は run dispatch されない", async () => {
  const dispatches: number[] = [];
  const systemEvents: Array<{ reason: string; itemCount: number }> = [];
  const service = createProactiveIngressService<{ id: string }>({
    attentionWindowConfig: {
      channelIdleMs: 20,
      channelMaxWaitMs: 200,
    },
    batchClassifier: createBatchClassifier({
      classifyChunk: async () => ({ action: "note", confidence: 1, reason: "contract-note" }),
    }),
    onSystemEvent: (input) => {
      systemEvents.push({ reason: input.reason, itemCount: input.itemCount });
    },
    dispatch: async (input) => {
      dispatches.push(input.items.length);
    },
  });

  await service.ingest({
    sessionKey: "slack:channel:C111",
    event: event(),
    payload: { id: "1" },
  });

  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(dispatches.length, 0);
  assert.equal(systemEvents.length, 1);
  assert.deepEqual(systemEvents[0], { reason: "contract-note", itemCount: 1 });
});
