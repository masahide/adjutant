import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createHeartbeatRunner } from "../../../../src/control-plane/heartbeat/heartbeat-runner.js";
import { HeartbeatResultStore } from "../../../../src/control-plane/heartbeat/result-store.js";

test("HeartbeatRunner: report_heartbeat_status が無いと failed", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "adjutant-heartbeat-runner-"));
  t.after(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  const store = HeartbeatResultStore.fromStateDir(stateDir);
  await store.initialize();

  const runner = createHeartbeatRunner({
    readPrompt: async () => "heartbeat prompt",
    executePrompt: async () => ({
      runId: "session:s1:run:1",
      toolCalls: [],
    }),
    resultStore: store,
  });

  const result = await runner.runOnce("manual");
  assert.equal(result.status, "failed");
  assert.equal(result.event.reason, "missing-report-heartbeat-status-tool-call");
  assert.equal(store.getLast()?.status, "failed");
});

test("HeartbeatRunner: valid payload は ran + sent として保存される", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "adjutant-heartbeat-runner-"));
  t.after(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  const store = HeartbeatResultStore.fromStateDir(stateDir);
  await store.initialize();
  const emitted: string[] = [];
  const runner = createHeartbeatRunner({
    readPrompt: async () => "heartbeat prompt",
    executePrompt: async () => ({
      runId: "session:s1:run:2",
      text: "needs attention",
      toolCalls: [
        {
          toolCallId: "tc_1",
          toolName: "report_heartbeat_status",
          status: "completed",
          rawInput: {
            status: "needs_attention",
            notify: true,
            reason: "stale thread",
          },
        },
      ],
    }),
    resultStore: store,
    emitEvent: (result) => {
      emitted.push(result.status);
    },
  });

  const result = await runner.runOnce("manual");
  assert.equal(result.status, "ran");
  assert.equal(result.event.status, "sent");
  assert.equal(result.runId, "session:s1:run:2");
  assert.deepEqual(emitted, ["ran"]);
});

test("HeartbeatRunner: beforeRun が skip を返したら skipped", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "adjutant-heartbeat-runner-"));
  t.after(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  const store = HeartbeatResultStore.fromStateDir(stateDir);
  await store.initialize();
  let executed = false;
  const runner = createHeartbeatRunner({
    readPrompt: async () => "heartbeat prompt",
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
