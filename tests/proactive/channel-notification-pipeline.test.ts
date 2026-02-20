import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  drainSystemEvents,
  enqueueSystemEvent,
  resetSystemEventQueueForTest,
} from "../../src/assistant/system-event-queue.js";
import { createChannelNotificationPipeline } from "../../src/proactive/channel-notification-pipeline.js";
import type { DualWriteCoordinator } from "../../src/proactive/dual-write-coordinator.js";
import type { ChannelNotificationInput } from "../../src/proactive/channel-plugin.js";
import { createTriggerFilter } from "../../src/proactive/trigger-filter.js";

function createPostInput(uid: string, text = "hello"): ChannelNotificationInput {
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
          text,
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
  afterEach(() => {
    resetSystemEventQueueForTest();
  });

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

  it("secondary classifier が pending を返すと pipeline は dispatch しない", async () => {
    let accepted = 0;
    const pipeline = createChannelNotificationPipeline({
      triggerFilter: createTriggerFilter({
        primaryClassifier: () => "run",
        secondaryClassifier: async () => "pending",
      }),
      queueConfig: { debounceMs: 1 },
      acceptMessage: async (request) => {
        accepted += 1;
        return { runId: request.idempotencyKey, status: "started" };
      },
    });

    await pipeline.enqueue(createPostInput("uid-secondary-pending"));
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(accepted, 0);
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

  it("デバウンス窓内の post は1回の dispatch に束ねられる", async () => {
    const accepted: Array<{ message: string; sessionKey: string }> = [];
    const pipeline = createChannelNotificationPipeline({
      triggerFilter: createTriggerFilter({ primaryClassifier: () => "run" }),
      queueConfig: { debounceMs: 20 },
      acceptMessage: async (request) => {
        accepted.push({ message: request.message, sessionKey: request.sessionKey });
        return { runId: request.idempotencyKey, status: "started" };
      },
    });

    await pipeline.enqueue(createPostInput("uid-d1", "first"));
    await pipeline.enqueue(createPostInput("uid-d2", "second"));
    await new Promise((resolve) => setTimeout(resolve, 35));

    assert.equal(accepted.length, 1);
    assert.equal(accepted[0]?.sessionKey, "main");
    assert.equal(accepted[0]?.message, "first\nsecond");
  });

  it("queue overflow(dropPolicy=summarize) では system event を注入しつつ継続する", async () => {
    const accepted: string[] = [];
    const systemEvents: string[] = [];
    const pipeline = createChannelNotificationPipeline({
      triggerFilter: createTriggerFilter({ primaryClassifier: () => "run" }),
      queueConfig: { cap: 2, debounceMs: 20, dropPolicy: "summarize" },
      enqueueSystemEvent: (text) => {
        systemEvents.push(text);
      },
      acceptMessage: async (request) => {
        accepted.push(request.message);
        return { runId: request.idempotencyKey, status: "started" };
      },
    });

    await pipeline.enqueue(createPostInput("uid-o1", "first"));
    await pipeline.enqueue(createPostInput("uid-o2", "second"));
    await pipeline.enqueue(createPostInput("uid-o3", "third"));
    await new Promise((resolve) => setTimeout(resolve, 40));

    assert.equal(accepted.length, 1);
    assert.equal(accepted[0], "second\nthird");
    assert.equal(systemEvents.length, 1);
    assert.equal(systemEvents[0]?.includes("[Queue overflow]"), true);
    assert.equal(systemEvents[0]?.includes("cap=2"), true);
  });

  it("連続する同一 system event は system-event-queue で重複排除される", async () => {
    const pipeline = createChannelNotificationPipeline({
      triggerFilter: createTriggerFilter({ primaryClassifier: () => "run" }),
      queueConfig: { debounceMs: 1 },
      enqueueSystemEvent: (text, opts) => {
        enqueueSystemEvent(text, opts);
      },
      acceptMessage: async (request) => {
        return { runId: request.idempotencyKey, status: "started" };
      },
    });

    await pipeline.enqueue(createReactionInput("uid-rd1"));
    await pipeline.enqueue(createReactionInput("uid-rd2"));
    await new Promise((resolve) => setTimeout(resolve, 10));

    const drained = drainSystemEvents("slack:channel:C123");
    assert.equal(drained.length, 1);
    assert.equal(drained[0]?.includes("[Slack reaction]"), true);
  });
});
