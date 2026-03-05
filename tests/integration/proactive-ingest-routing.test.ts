import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { CollectorIngestRequest } from "../../src/contracts/process-rpc/method-types.js";
import { createHeartbeatRunner } from "../../src/control-plane/heartbeat/heartbeat-runner.js";
import { HeartbeatResultStore } from "../../src/control-plane/heartbeat/result-store.js";
import { createBatchClassifier } from "../../src/control-plane/proactive/batch-classifier.js";
import { createGlobalConcurrencyQueue } from "../../src/control-plane/proactive/global-concurrency-queue.js";
import { createProactiveIngressService } from "../../src/control-plane/proactive/ingress-service.js";
import { createPendingFlusher } from "../../src/control-plane/proactive/pending-flusher.js";
import { WatermarkStore } from "../../src/control-plane/proactive/watermark-store.js";
import { CollectorIngestHandler } from "../../src/control-plane/process-rpc/ingest-handler.js";

function createRequest(input: {
  messageId: string;
  dedupeKey: string;
  channelId: string;
  text: string;
}): CollectorIngestRequest {
  return {
    messageId: input.messageId,
    dedupeKey: input.dedupeKey,
    source: "slack",
    occurredAt: "2026-03-05T00:00:00.000Z",
    payload: {
      schema: "adjutant.event.v1.1",
      uid: input.dedupeKey,
      source: "slack",
      kind: "post",
      ts: "2026-03-05T00:00:00.000Z",
      detail: {
        slack: {
          channel_id: input.channelId,
          message_ts: input.dedupeKey.split("@")[1] ?? "1730000000.100",
          text: input.text,
        },
      },
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("ingest 後に immediate と accumulate が分岐する", async () => {
  const dispatched: Array<{ source: string; sessionKey: string; count: number }> = [];
  const proactive = createProactiveIngressService<{ request: CollectorIngestRequest }>({
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
        sessionKey: input.sessionKey,
        count: input.items.length,
      });
    },
  });

  const handler = new CollectorIngestHandler({
    onAccept: async (projection, request) => {
      await proactive.ingest({
        sessionKey: projection.sessionKey,
        event: projection.rawEvent,
        payload: { request },
      });
    },
  });

  await handler.accept(
    createRequest({
      messageId: "msg_dm_1",
      dedupeKey: "slack:D111@1730000000.100",
      channelId: "D111",
      text: "dm immediate",
    })
  );
  await handler.accept(
    createRequest({
      messageId: "msg_ch_1",
      dedupeKey: "slack:C111@1730000000.101",
      channelId: "C111",
      text: "channel-1",
    })
  );
  await handler.accept(
    createRequest({
      messageId: "msg_ch_2",
      dedupeKey: "slack:C111@1730000000.102",
      channelId: "C111",
      text: "channel-2",
    })
  );

  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(dispatched.length, 2);

  const dm = dispatched.find((entry) => entry.source === "dm");
  assert.equal(dm?.count, 1);
  assert.equal(dm?.sessionKey, "slack:D111");

  const channel = dispatched.find((entry) => entry.source === "channel");
  assert.equal(channel?.count, 2);
  assert.equal(channel?.sessionKey, "slack:channel:C111");
});

test("collector burst / DM burst / flusher / heartbeat の同時負荷でも処理できる", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "adjutant-proactive-burst-"));
  t.after(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  const timelinePath = join(stateDir, "timeline.jsonl");
  await writeFile(
    timelinePath,
    `${JSON.stringify({
      schema: "adjutant.timeline.record.v1.5",
      recordType: "event",
      uid: "stale-1",
      sessionKey: "slack:channel:C_STALE",
      ts: "2024-01-01T00:00:00.000Z",
      loggedAt: "2024-01-01T00:00:00.000Z",
      event: {
        schema: "adjutant.event.v1.1",
        uid: "slack:C_STALE@1",
        source: "slack",
        kind: "post",
        actor: "U_STALE",
        ts: "2024-01-01T00:00:00.000Z",
        detail: {
          slack: {
            channel_id: "C_STALE",
            message_ts: "1704067200.000100",
            text: "stale",
          },
        },
      },
    })}\n`,
    "utf8"
  );

  const globalQueue = createGlobalConcurrencyQueue({
    maxConcurrent: 1,
    dmBurstSlot: 1,
    maxRunningDm: 2,
    starvationMs: 1_000,
  });
  const dispatched: Array<{ source: string; sessionKey: string; count: number }> = [];
  const proactive = createProactiveIngressService<{ request: CollectorIngestRequest }>({
    attentionWindowConfig: {
      channelIdleMs: 30,
      channelMaxWaitMs: 250,
    },
    globalQueue,
    batchClassifier: createBatchClassifier({
      classifyChunk: async () => ({ action: "respond", confidence: 1, reason: "ok" }),
    }),
    dispatch: async (input) => {
      dispatched.push({
        source: input.source,
        sessionKey: input.sessionKey,
        count: input.items.length,
      });
      await sleep(10);
    },
  });
  const handler = new CollectorIngestHandler({
    onAccept: async (projection, request) => {
      await proactive.ingest({
        sessionKey: projection.sessionKey,
        event: projection.rawEvent,
        payload: { request },
      });
    },
  });

  const watermarkStore = WatermarkStore.fromStateDir(stateDir);
  await watermarkStore.initialize();
  const flusherEnqueued: string[] = [];
  const flusher = createPendingFlusher({
    timelinePath,
    watermarkStore,
    staleMs: 60_000,
    nowMs: () => Date.parse("2026-03-05T00:10:00.000Z"),
    enqueueSession: async ({ sessionKey }) => {
      const lease = await globalQueue.acquire("flusher");
      try {
        flusherEnqueued.push(sessionKey);
        await sleep(10);
      } finally {
        lease.release();
      }
    },
  });

  const heartbeatStore = HeartbeatResultStore.fromStateDir(stateDir);
  await heartbeatStore.initialize();
  const heartbeatRunner = createHeartbeatRunner({
    globalQueue,
    readPrompt: async () => "heartbeat check",
    executePrompt: async () => ({
      runId: "session:main:run:999",
      toolCalls: [
        {
          toolCallId: "hb_1",
          toolName: "report_heartbeat_status",
          status: "completed",
          rawInput: {
            status: "no_action_needed",
            notify: false,
            reason: "ok",
          },
        },
      ],
    }),
    resultStore: heartbeatStore,
  });

  const channelBurst = 15;
  const dmBurst = 12;
  const ingestTasks: Array<Promise<unknown>> = [];
  for (let index = 0; index < channelBurst; index += 1) {
    ingestTasks.push(
      handler.accept(
        createRequest({
          messageId: `msg_ch_burst_${index}`,
          dedupeKey: `slack:C_BURST@1730000000.${String(100 + index)}`,
          channelId: "C_BURST",
          text: `channel-${index}`,
        })
      )
    );
  }
  for (let index = 0; index < dmBurst; index += 1) {
    ingestTasks.push(
      handler.accept(
        createRequest({
          messageId: `msg_dm_burst_${index}`,
          dedupeKey: `slack:D_BURST@1730000001.${String(100 + index)}`,
          channelId: "D_BURST",
          text: `dm-${index}`,
        })
      )
    );
  }

  const [heartbeatResult, flusherResult] = await Promise.all([
    heartbeatRunner.runOnce("verify-burst"),
    flusher.tick(),
    Promise.all(ingestTasks),
  ]).then((results) => [results[0], results[1]] as const);

  await sleep(300);

  assert.equal(heartbeatResult.status, "ran");
  assert.equal(heartbeatStore.getLast()?.status, "ran");
  assert.deepEqual(flusherResult.firedSessionKeys, ["slack:channel:C_STALE"]);
  assert.deepEqual(flusherEnqueued, ["slack:channel:C_STALE"]);

  const channelDispatches = dispatched.filter((entry) => entry.source === "channel");
  assert.equal(channelDispatches.length, 1);
  assert.equal(channelDispatches[0]?.sessionKey, "slack:channel:C_BURST");
  assert.equal(channelDispatches[0]?.count, channelBurst);

  const dmTotal = dispatched
    .filter((entry) => entry.source === "dm")
    .reduce((sum, entry) => sum + entry.count, 0);
  assert.equal(dmTotal, dmBurst);
});
