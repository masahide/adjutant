import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createChannelNotificationPipeline } from "../../src/openclaw/channel-notification-pipeline.js";
import type { DualWriteCoordinator } from "../../src/openclaw/dual-write-coordinator.js";
import type { ChannelNotificationInput } from "../../src/openclaw/channel-plugin.js";
import { createTriggerFilter } from "../../src/openclaw/trigger-filter.js";

function createPostInput(uid: string): ChannelNotificationInput {
  return {
    accountId: "acc-1",
    channelId: "slack",
    event: {
      schema: "adjutant.event.v1.1",
      uid,
      source: "slack",
      kind: "post",
      ts: "2026-02-17T00:00:00+09:00",
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

function createReactionInput(uid: string): ChannelNotificationInput {
  return {
    accountId: "acc-1",
    channelId: "slack",
    event: {
      schema: "adjutant.event.v1.1",
      uid,
      source: "slack",
      kind: "reaction",
      action: "added",
      actor: "U222",
      ts: "2026-02-17T00:00:00+09:00",
      detail: {
        slack: {
          channel_id: "C123",
          message_ts: "1740000000.000100",
          emoji: "thumbsup",
          user: "U222",
        },
      },
    },
  };
}

function createDualWriteStub(
  status: "committed" | "pending-timeline" | "pending-session-backfill"
): DualWriteCoordinator {
  return {
    appendEvent: async () => ({ status }),
    appendAssistant: async () => ({ status: "committed" }),
    retryPending: async () => ({
      timelineRecovered: 0,
      sessionRecovered: 0,
      pendingTimeline: 0,
      pendingSessionBackfill: 0,
    }),
    hasPendingTimelineWrites: () => false,
    hasPendingSessionBackfill: () => false,
    listPendingSessionBackfillUids: () => [],
  };
}

describe("channel-notification-pipeline", () => {
  it("run 判定イベントは debounce flush 後に acceptMessage へ流れる", async () => {
    const accepted: Array<{ message: string; sessionKey: string; idempotencyKey: string }> = [];
    const pipeline = createChannelNotificationPipeline({
      triggerFilter: createTriggerFilter({ primaryClassifier: () => "run" }),
      queueConfig: { debounceMs: 1 },
      acceptMessage: async (request) => {
        accepted.push(request);
        return { runId: request.idempotencyKey, status: "started" };
      },
    });

    await pipeline.enqueue(createPostInput("uid-1"));
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(accepted.length, 1);
    assert.equal(accepted[0]?.message, "hello");
    assert.equal(accepted[0]?.sessionKey, "main");
    assert.ok(accepted[0]?.idempotencyKey.startsWith("sha256:"));
  });

  it("system 判定イベントは enqueueSystemEvent に接続される", async () => {
    const systemEvents: Array<{ text: string; sessionKey: string; contextKey?: string }> = [];
    const pipeline = createChannelNotificationPipeline({
      triggerFilter: createTriggerFilter({ primaryClassifier: () => "run" }),
      queueConfig: { debounceMs: 1 },
      enqueueSystemEvent: (text, opts) => {
        systemEvents.push({ text, sessionKey: opts.sessionKey, contextKey: opts.contextKey });
      },
      acceptMessage: async (request) => {
        return { runId: request.idempotencyKey, status: "started" };
      },
    });

    await pipeline.enqueue(createReactionInput("uid-r1"));
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(systemEvents.length, 1);
    assert.ok(systemEvents[0]?.text.includes("[Slack reaction]"));
    assert.ok(systemEvents[0]?.contextKey?.startsWith("slack:reaction:"));
  });

  it("self event は drop され run/system ともに流れない", async () => {
    let accepted = 0;
    let systemCount = 0;
    const pipeline = createChannelNotificationPipeline({
      triggerFilter: createTriggerFilter({ primaryClassifier: () => "run" }),
      queueConfig: { debounceMs: 1 },
      resolveSelfState: () => "self",
      enqueueSystemEvent: () => {
        systemCount += 1;
      },
      acceptMessage: async (request) => {
        accepted += 1;
        return { runId: request.idempotencyKey, status: "started" };
      },
    });

    await pipeline.enqueue(createPostInput("uid-self"));
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(accepted, 0);
    assert.equal(systemCount, 0);
  });

  it("dual write が pending-timeline のときは dispatch へ進めない", async () => {
    let accepted = 0;
    const warnings: string[] = [];
    const pipeline = createChannelNotificationPipeline({
      triggerFilter: createTriggerFilter({ primaryClassifier: () => "run" }),
      dualWriteCoordinator: createDualWriteStub("pending-timeline"),
      queueConfig: { debounceMs: 1 },
      onWarn: (message) => warnings.push(message),
      acceptMessage: async (request) => {
        accepted += 1;
        return { runId: request.idempotencyKey, status: "started" };
      },
    });

    await pipeline.enqueue(createPostInput("uid-pending-timeline"));
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(accepted, 0);
    assert.equal(warnings.includes("pipeline-dual-write-blocked"), true);
  });

  it("dual write が pending-session-backfill でも run 判定なら dispatch へ進む", async () => {
    let accepted = 0;
    const warnings: string[] = [];
    const pipeline = createChannelNotificationPipeline({
      triggerFilter: createTriggerFilter({ primaryClassifier: () => "run" }),
      dualWriteCoordinator: createDualWriteStub("pending-session-backfill"),
      queueConfig: { debounceMs: 1 },
      onWarn: (message) => warnings.push(message),
      acceptMessage: async (request) => {
        accepted += 1;
        return { runId: request.idempotencyKey, status: "started" };
      },
    });

    await pipeline.enqueue(createPostInput("uid-pending-session"));
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(accepted, 1);
    assert.equal(warnings.includes("pipeline-dual-write-session-backfill"), true);
  });
});
