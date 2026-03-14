import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { createHeartbeatRunner } from "../../../../src/control-plane/heartbeat/heartbeat-runner.js";
import { HeartbeatResultStore } from "../../../../src/control-plane/heartbeat/result-store.js";

async function createStore(t: test.TestContext): Promise<HeartbeatResultStore> {
  const stateDir = await mkdtemp(join(tmpdir(), "adjutant-heartbeat-runner-"));
  t.after(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });
  const store = HeartbeatResultStore.fromStateDir(stateDir);
  await store.initialize();
  return store;
}

test("HeartbeatRunner: HEARTBEAT.md が無い場合は default prompt で実行する", async (t) => {
  const store = await createStore(t);
  let observedPrompt = "";
  const runner = createHeartbeatRunner({
    readPrompt: async () => {
      const error = new Error("not found") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    },
    executePrompt: async ({ prompt }) => {
      observedPrompt = prompt;
      return {
        runId: "session:main:run:1",
        text: "HEARTBEAT_OK",
        toolCalls: [],
      };
    },
    resultStore: store,
  });

  const result = await runner.runOnce("manual");
  assert.equal(result.status, "ran");
  assert.equal(result.event.status, "ok-token");
  assert.match(observedPrompt, /If nothing needs attention, reply HEARTBEAT_OK\./);
});

test("HeartbeatRunner: HEARTBEAT.md が実質空なら skipped", async (t) => {
  const store = await createStore(t);
  let executed = false;
  const runner = createHeartbeatRunner({
    readPrompt: async () => "   \n",
    executePrompt: async () => {
      executed = true;
      return {
        toolCalls: [],
      };
    },
    resultStore: store,
  });

  const result = await runner.runOnce("manual");
  assert.equal(result.status, "skipped");
  assert.equal(result.event.status, "skipped");
  assert.equal(result.event.reason, "empty-heartbeat-file");
  assert.equal(executed, false);
});

test("HeartbeatRunner: HEARTBEAT_OK は ran + ok-token で transcript callback を呼ばない", async (t) => {
  const store = await createStore(t);
  const recorded: unknown[] = [];
  const runner = createHeartbeatRunner({
    readPrompt: async () => "Check workspace status.",
    executePrompt: async () => ({
      runId: "session:main:run:2",
      text: "HEARTBEAT_OK",
      toolCalls: [],
    }),
    resultStore: store,
    recordMeaningfulText: async (input) => {
      recorded.push(input);
    },
  });

  const result = await runner.runOnce("manual");
  assert.equal(result.status, "ran");
  assert.equal(result.event.status, "ok-token");
  assert.equal(recorded.length, 0);
});

test("HeartbeatRunner: 空 text は ran + ok-empty として扱う", async (t) => {
  const store = await createStore(t);
  const runner = createHeartbeatRunner({
    readPrompt: async () => "Check workspace status.",
    executePrompt: async () => ({
      runId: "session:main:run:3",
      text: "   ",
      toolCalls: [],
    }),
    resultStore: store,
  });

  const result = await runner.runOnce("manual");
  assert.equal(result.status, "ran");
  assert.equal(result.event.status, "ok-empty");
});

test("HeartbeatRunner: 有意味な応答は ran + sent で transcript callback に渡す", async (t) => {
  const store = await createStore(t);
  const recorded: unknown[] = [];
  const runner = createHeartbeatRunner({
    readPrompt: async () => "Check workspace status.",
    executePrompt: async () => ({
      runId: "session:main:run:4",
      text: "stale notification needs attention",
      toolCalls: [],
    }),
    resultStore: store,
    recordMeaningfulText: async (input) => {
      recorded.push({ runId: input.runId ?? "", text: input.text, reason: input.reason });
    },
  });

  const result = await runner.runOnce("manual");
  assert.equal(result.status, "ran");
  assert.equal(result.event.status, "sent");
  assert.equal(result.event.reason, "stale notification needs attention");
  assert.deepEqual(recorded, [
    {
      runId: "session:main:run:4",
      text: "stale notification needs attention",
      reason: "manual",
    },
  ]);
});

test("HeartbeatRunner: beforeRun が skip を返したら skipped", async (t) => {
  const store = await createStore(t);
  let executed = false;
  const runner = createHeartbeatRunner({
    readPrompt: async () => "Check workspace status.",
    beforeRun: async () => ({ skipReason: "session-busy" }),
    executePrompt: async () => {
      executed = true;
      return {
        toolCalls: [],
      };
    },
    resultStore: store,
  });

  const result = await runner.runOnce("manual");
  assert.equal(result.status, "skipped");
  assert.equal(result.event.reason, "session-busy");
  assert.equal(executed, false);
});

test("HeartbeatRunner: periodic start は busy skip の後に再試行できる", async (t) => {
  const store = await createStore(t);
  const scheduled: Array<() => void> = [];
  const statuses: string[] = [];
  let attempts = 0;
  const runner = createHeartbeatRunner({
    intervalMs: 100,
    setIntervalFn: ((callback: () => void) => {
      scheduled.push(callback);
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval,
    clearIntervalFn: (() => undefined) as typeof clearInterval,
    readPrompt: async () => "Check workspace status.",
    beforeRun: async () => {
      attempts += 1;
      return attempts === 1 ? { skipReason: "session-busy" } : null;
    },
    executePrompt: async () => ({
      runId: "session:main:run:6",
      text: "HEARTBEAT_OK",
      toolCalls: [],
    }),
    resultStore: store,
    emitEvent: (result) => {
      statuses.push(result.status);
    },
  });

  runner.start();
  assert.equal(scheduled.length, 1);
  scheduled[0]?.();
  await sleep(5);
  scheduled[0]?.();
  for (let index = 0; index < 10; index += 1) {
    if (store.list({ limit: 10 }).items.length >= 2) {
      break;
    }
    await sleep(5);
  }

  const history = store.list({ limit: 10 }).items;
  assert.equal(history.length, 2);
  assert.deepEqual(statuses, ["skipped", "ran"]);
  assert.equal(history[0]?.status, "ran");
  assert.equal(history[1]?.status, "skipped");
});

test("HeartbeatRunner: legacy report_heartbeat_status payload も互換として受理する", async (t) => {
  const store = await createStore(t);
  const runner = createHeartbeatRunner({
    readPrompt: async () => "Check workspace status.",
    executePrompt: async () => ({
      runId: "session:main:run:5",
      text: "legacy structured heartbeat",
      toolCalls: [
        {
          toolCallId: "tc_1",
          toolName: "report_heartbeat_status",
          status: "completed",
          rawInput: {
            status: "needs_attention",
            notify: true,
            reason: "legacy-alert",
          },
        },
      ],
    }),
    resultStore: store,
  });

  const result = await runner.runOnce("manual");
  assert.equal(result.status, "ran");
  assert.equal(result.event.status, "sent");
  assert.equal(result.event.reason, "legacy-alert");
});
