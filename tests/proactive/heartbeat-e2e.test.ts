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

  it("stale post が統合タイムラインに残ると heartbeat 自律 tick で run する", async () => {
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
          uid: "uid-stale-post",
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
            status: "completed",
            durationMs: 1,
            text: "ALERT: follow-up required",
          };
        },
      });

      const handle = startHeartbeat({
        dataDir: tempDir,
        workspaceDir: tempDir,
        sessionEntriesPath: join(tempDir, "sessions.json"),
        heartbeatFilePath: join(tempDir, "assistant", "prompts", "HEARTBEAT.md"),
        soulFilePath: join(tempDir, "assistant", "prompts", "SOUL.md"),
        userFilePath: join(tempDir, "assistant", "prompts", "USER.md"),
        agentsFilePath: join(tempDir, "assistant", "prompts", "AGENTS.md"),
        timelinePath,
        heartbeatStaleMs: 60 * 1000,
        ackMaxChars: 0,
        intervalMs: 10,
      });

      await waitUntil(() => runAgentCount === 1);
      handle.stop();
      await new Promise((resolve) => setTimeout(resolve, 30));
      unsubscribe();

      assert.equal(statuses.includes("sent"), true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("最新対応境界がある場合は heartbeat 自律 tick でも skipped(no-stale-post)", async () => {
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
          uid: "uid-post-before-assistant",
          ts: "2026-02-17T00:00:00.000Z",
        })
      );
      await dualWrite.appendAssistant({
        uid: "uid-assistant-action",
        timelineRecord: {
          uid: "uid-assistant-action",
          recordType: "action",
          role: "assistant",
          ts: "2026-02-17T00:15:00.000Z",
        },
        sessionRecord: {
          uid: "uid-assistant-action",
          recordType: "action",
          role: "assistant",
          ts: "2026-02-17T00:15:00.000Z",
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 20));

      let runAgentCount = 0;
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
            status: "completed",
            durationMs: 1,
            text: "ALERT: unexpected",
          };
        },
      });

      const handle = startHeartbeat({
        dataDir: tempDir,
        workspaceDir: tempDir,
        sessionEntriesPath: join(tempDir, "sessions.json"),
        heartbeatFilePath: join(tempDir, "assistant", "prompts", "HEARTBEAT.md"),
        soulFilePath: join(tempDir, "assistant", "prompts", "SOUL.md"),
        userFilePath: join(tempDir, "assistant", "prompts", "USER.md"),
        agentsFilePath: join(tempDir, "assistant", "prompts", "AGENTS.md"),
        timelinePath,
        heartbeatStaleMs: 60 * 1000,
        ackMaxChars: 0,
        intervalMs: 10,
      });

      await waitUntil(() => getLastHeartbeatEvent()?.reason === "no-stale-post");
      handle.stop();
      await new Promise((resolve) => setTimeout(resolve, 30));

      assert.equal(runAgentCount, 0);
      const lastEvent = getLastHeartbeatEvent();
      assert.equal(lastEvent?.status, "skipped");
      assert.equal(lastEvent?.reason, "no-stale-post");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
