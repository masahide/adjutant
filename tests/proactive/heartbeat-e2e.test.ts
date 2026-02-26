import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  getLastHeartbeatEvent,
  onHeartbeatEvent,
  resetHeartbeatRunnerForTest,
  setHeartbeatRuntimeForTest,
  startHeartbeat,
} from "../../src/assistant/heartbeat-runner.js";
import { createChannelNotificationPipeline } from "../../src/proactive/channel-notification-pipeline.js";
import { createDualWriteCoordinator } from "../../src/proactive/dual-write-coordinator.js";
import type { ChannelNotificationInput } from "../../src/proactive/channel-plugin.js";
import { createTriggerFilter } from "../../src/proactive/trigger-filter.js";

async function waitUntil(
  predicate: () => boolean,
  opts: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 1000;
  const intervalMs = opts.intervalMs ?? 10;
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timeout after ${timeoutMs}ms`);
}

async function preparePromptFiles(baseDir: string): Promise<void> {
  const promptsDir = join(baseDir, "assistant", "prompts");
  await mkdir(promptsDir, { recursive: true });
  await writeFile(join(promptsDir, "HEARTBEAT.md"), "Heartbeat prompt", "utf8");
  await writeFile(join(promptsDir, "SOUL.md"), "You are Adjutant.", "utf8");
  await writeFile(join(promptsDir, "USER.md"), "User preference.", "utf8");
  await writeFile(join(promptsDir, "AGENTS.md"), "Agent guideline.", "utf8");
}

function createPostInput(params: { uid: string; ts: string }): ChannelNotificationInput {
  return {
    accountId: "acc-1",
    channelId: "slack",
    event: {
      schema: "adjutant.event.v1.1",
      uid: params.uid,
      source: "slack",
      kind: "post",
      ts: params.ts,
      actor: "U111",
      detail: {
        slack: {
          channel_id: "C123",
          message_ts: "1740000000.000100",
          text: "hello",
        },
      },
    },
  };
}

describe("heartbeat-e2e", () => {
  afterEach(() => {
    resetHeartbeatRunnerForTest();
  });

  it("統合パイプラインでイベント蓄積後、heartbeat 自律 tick で run して sent になる", async () => {
    const tempDir = await mkdtemp(`${tmpdir()}/adjutant-heartbeat-e2e-`);
    try {
      await preparePromptFiles(tempDir);

      const timelinePath = join(tempDir, "memory", "timeline.jsonl");
      const sessionPath = join(tempDir, "memory", "session-main.jsonl");
      await mkdir(dirname(timelinePath), { recursive: true });

      const dualWrite = createDualWriteCoordinator({
        appendTimelineRecord: async (record) => {
          await appendFile(timelinePath, `${JSON.stringify(record)}\n`, "utf8");
        },
        appendSessionRecord: async (record) => {
          await appendFile(sessionPath, `${JSON.stringify(record)}\n`, "utf8");
        },
      });

      const pipeline = createChannelNotificationPipeline({
        triggerFilter: createTriggerFilter({ primaryClassifier: () => "run" }),
        dualWriteCoordinator: dualWrite,
        queueConfig: { debounceMs: 1 },
        acceptMessage: async (request) => ({ runId: request.idempotencyKey, status: "started" }),
      });

      await pipeline.enqueue(
        createPostInput({
          uid: "uid-heartbeat-e2e-post",
          ts: "2026-02-17T00:00:00.000Z",
        })
      );
      await new Promise((resolve) => setTimeout(resolve, 20));

      let runAgentCount = 0;
      const statuses: string[] = [];
      const unsubscribe = onHeartbeatEvent((evt) => statuses.push(evt.status));
      setHeartbeatRuntimeForTest({
        now: () => new Date("2026-02-17T00:20:00.000Z"),
        readEvents: async () => [],
        readMemoryFiles: async () => ({
          longTerm: null,
          daily: null,
          yesterday: null,
        }),
        buildEventContext: () => ({ text: "", truncated: false, eventCount: 0 }),
        getQueueSize: () => 0,
        runAgent: async () => {
          runAgentCount += 1;
          return {
            text: "ALERT: follow-up required",
            modelId: "gpt-4o-mini",
            toolCalls: [
              {
                name: "report_heartbeat_status",
                result: {
                  status: "needs_attention",
                  notify: true,
                  reason: "ALERT: follow-up required",
                },
              },
            ],
          };
        },
      });

      const handle = startHeartbeat({
        dataDir: tempDir,
        stateDir: join(tempDir, "state"),
        workspaceDir: tempDir,
        sessionEntriesPath: join(tempDir, "sessions.json"),
        heartbeatFilePath: join(tempDir, "assistant", "prompts", "HEARTBEAT.md"),
        soulFilePath: join(tempDir, "assistant", "prompts", "SOUL.md"),
        userFilePath: join(tempDir, "assistant", "prompts", "USER.md"),
        agentsFilePath: join(tempDir, "assistant", "prompts", "AGENTS.md"),
        intervalMs: 10,
      });

      await waitUntil(() => runAgentCount >= 1);
      handle.stop();
      await new Promise((resolve) => setTimeout(resolve, 30));
      unsubscribe();

      assert.equal(statuses.includes("sent"), true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("requests-in-flight で最初は skipped、次 tick で run される", async () => {
    const tempDir = await mkdtemp(`${tmpdir()}/adjutant-heartbeat-e2e-`);
    try {
      await preparePromptFiles(tempDir);

      let queueCalls = 0;
      let runAgentCount = 0;
      setHeartbeatRuntimeForTest({
        getQueueSize: () => {
          queueCalls += 1;
          return queueCalls === 1 ? 1 : 0;
        },
        readEvents: async () => [],
        readMemoryFiles: async () => ({
          longTerm: null,
          daily: null,
          yesterday: null,
        }),
        buildEventContext: () => ({ text: "", truncated: false, eventCount: 0 }),
        runAgent: async () => {
          runAgentCount += 1;
          return {
            text: "ok",
            modelId: "gpt-4o-mini",
            toolCalls: [
              {
                name: "report_heartbeat_status",
                result: {
                  status: "no_action_needed",
                  notify: false,
                  reason: "ok",
                },
              },
            ],
          };
        },
      });

      const handle = startHeartbeat({
        dataDir: tempDir,
        stateDir: join(tempDir, "state"),
        workspaceDir: tempDir,
        sessionEntriesPath: join(tempDir, "sessions.json"),
        heartbeatFilePath: join(tempDir, "assistant", "prompts", "HEARTBEAT.md"),
        soulFilePath: join(tempDir, "assistant", "prompts", "SOUL.md"),
        userFilePath: join(tempDir, "assistant", "prompts", "USER.md"),
        agentsFilePath: join(tempDir, "assistant", "prompts", "AGENTS.md"),
        intervalMs: 20,
        retryDelayMs: 5,
      });

      await waitUntil(() => runAgentCount >= 1, { timeoutMs: 2000 });
      handle.stop();
      await new Promise((resolve) => setTimeout(resolve, 30));

      const lastEvent = getLastHeartbeatEvent();
      assert.notEqual(lastEvent, null);
      assert.equal(lastEvent?.status === "ok-empty" || lastEvent?.status === "sent", true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
