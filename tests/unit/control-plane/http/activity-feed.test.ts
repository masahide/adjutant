import assert from "node:assert/strict";
import test from "node:test";

import { buildActivityFeedResponse } from "../../../../src/control-plane/http/activity-feed.js";
import type { TimelineRecordV1_5 } from "../../../../src/control-plane/proactive/schema.js";

type TimelineEventRecord = Extract<TimelineRecordV1_5, { recordType: "event" }>;

const baseEvent = (overrides: Partial<TimelineEventRecord>): TimelineEventRecord => ({
  schema: "adjutant.timeline.record.v1.5",
  recordType: "event",
  sessionKey: "slack-activity",
  uid: "uid-default",
  ts: "2026-03-14T10:00:00.000Z",
  loggedAt: "2026-03-14T10:00:01.000Z",
  timelineOffset: 0,
  event: {
    schema: "adjutant.event.v1.1",
    uid: "evt-default",
    source: "slack",
    kind: "notification",
    ts: "2026-03-14T10:00:00.000Z",
    subject: "subject",
    detail: {
      slack: {
        channel_id: "C1",
        notification_type: "mention",
        message_text: "hello",
        permalink: "https://example.slack.com/archives/C1/p1",
      },
    },
  },
  ...overrides,
});

test("ActivityFeed は notification を新しい順に返す", () => {
  const response = buildActivityFeedResponse(
    [
      baseEvent({ uid: "uid-1", ts: "2026-03-14T10:00:00.000Z", timelineOffset: 1 }),
      baseEvent({ uid: "uid-2", ts: "2026-03-14T11:00:00.000Z", timelineOffset: 2 }),
      {
        schema: "adjutant.timeline.record.v1.5",
        recordType: "action",
        sessionKey: "slack-activity",
        uid: "action-1",
        ts: "2026-03-14T12:00:00.000Z",
        loggedAt: "2026-03-14T12:00:00.000Z",
        timelineOffset: 3,
        actionType: "assistant_final",
      },
    ],
    undefined,
    { nowIso: () => "2026-03-14T12:00:00.000Z" }
  );

  assert.deepEqual(
    response.items.map((item) => item.activityId),
    ["uid-2", "uid-1"]
  );
  assert.equal(response.generatedAt, "2026-03-14T12:00:00.000Z");
});

test("ActivityFeed は limit と cursor に従ってページングする", () => {
  const records = [
    baseEvent({ uid: "uid-1", ts: "2026-03-14T10:00:00.000Z", timelineOffset: 1 }),
    baseEvent({ uid: "uid-2", ts: "2026-03-14T11:00:00.000Z", timelineOffset: 2 }),
    baseEvent({ uid: "uid-3", ts: "2026-03-14T12:00:00.000Z", timelineOffset: 3 }),
  ];

  const first = buildActivityFeedResponse(records, { limit: 2 }, { nowIso: () => "now" });
  assert.deepEqual(
    first.items.map((item) => item.activityId),
    ["uid-3", "uid-2"]
  );
  assert.equal(typeof first.nextCursor, "string");

  const second = buildActivityFeedResponse(
    records,
    { limit: 2, cursor: first.nextCursor },
    { nowIso: () => "now" }
  );
  assert.deepEqual(
    second.items.map((item) => item.activityId),
    ["uid-1"]
  );
  assert.equal(second.nextCursor, undefined);
});

test("ActivityFeed は notification_decision があれば item を上書きする", () => {
  const response = buildActivityFeedResponse([
    baseEvent({ uid: "uid-1", ts: "2026-03-14T10:00:00.000Z", timelineOffset: 1 }),
    {
      schema: "adjutant.timeline.record.v1.5",
      recordType: "event",
      sessionKey: "slack-activity",
      uid: "uid-1:decision:run-1",
      ts: "2026-03-14T10:01:00.000Z",
      loggedAt: "2026-03-14T10:01:00.000Z",
      timelineOffset: 2,
      event: {
        schema: "adjutant.event.v1.1",
        uid: "uid-1:decision:run-1",
        source: "slack",
        kind: "notification_decision",
        ts: "2026-03-14T10:01:00.000Z",
        subject: "direct ask",
        meta: {
          notificationUid: "uid-1",
          action: "draft_reply",
          reason: "direct ask",
          replyText: "確認します",
          originalMessageText: "hello",
        },
      },
    },
  ]);

  assert.equal(response.items.length, 1);
  assert.equal(response.items[0]?.kind, "draft_reply");
  assert.equal(response.items[0]?.messageText, "確認します");
  assert.equal(response.items[0]?.summary, "direct ask");
});

test("ActivityFeed は permalink fallback 失敗の needs_review summary を表示する", () => {
  const response = buildActivityFeedResponse([
    baseEvent({ uid: "uid-2", ts: "2026-03-14T10:00:00.000Z", timelineOffset: 1 }),
    {
      schema: "adjutant.timeline.record.v1.5",
      recordType: "event",
      sessionKey: "slack-activity",
      uid: "uid-2:decision:run-2",
      ts: "2026-03-14T10:01:00.000Z",
      loggedAt: "2026-03-14T10:01:00.000Z",
      timelineOffset: 2,
      event: {
        schema: "adjutant.event.v1.1",
        uid: "uid-2:decision:run-2",
        source: "slack",
        kind: "notification_decision",
        ts: "2026-03-14T10:01:00.000Z",
        subject: "informational",
        meta: {
          notificationUid: "uid-2",
          action: "needs_review",
          reason: "informational",
          reviewNotes: "play_slack_search failed: failed to derive permalink for mode=thread",
          originalMessageText: "hello",
        },
      },
    },
  ]);

  assert.equal(response.items.length, 1);
  assert.equal(response.items[0]?.kind, "needs_review");
  assert.equal(response.items[0]?.messageText, "hello");
  assert.equal(
    response.items[0]?.summary,
    "play_slack_search failed: failed to derive permalink for mode=thread"
  );
});
