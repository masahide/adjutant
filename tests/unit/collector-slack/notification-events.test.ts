import assert from "node:assert/strict";
import test from "node:test";

import {
  enrichNotificationEvent,
  isDirectMentionNotificationEvent,
  normalizeDirectMentionNotificationFromRawPayload,
} from "../../../src/collector-slack/notification-events.js";
import type { NormalizedEvent, SlackNotificationDetail } from "../../../src/core/events.js";

test("raw payload の direct mention から notification event を生成できる", () => {
  const event = normalizeDirectMentionNotificationFromRawPayload(
    {
      type: "message",
      channel: "DTESTDM001",
      text: "<@UTEST0001>test",
      blocks: [
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_section",
              elements: [
                { type: "user", user_id: "UTEST0001" },
                { type: "text", text: "test" },
              ],
            },
          ],
        },
      ],
      user: "UTEST0001",
      team: "TTEAM0001",
      event_ts: "1773477181.004799",
      ts: "1773477181.004799",
    },
    {
      selfUserIds: ["UTEST0001"],
      workspaceHost: "workspace-alpha.slack.com",
      now: new Date("2026-03-14T17:00:00.000+09:00"),
    }
  );

  assert.ok(event);
  const slack =
    event.detail && "slack" in event.detail
      ? (event.detail.slack as SlackNotificationDetail)
      : undefined;
  assert.equal(event?.kind, "notification");
  assert.equal(slack?.notification_type, "mention");
  assert.equal(slack?.workspace_host, "workspace-alpha.slack.com");
  assert.equal(slack?.message_ts, "1773477181.004799");
  assert.equal(slack?.mention_target_user_id, "UTEST0001");
  assert.equal(slack?.is_direct_mention, true);
  assert.equal(
    slack?.permalink,
    "https://workspace-alpha.slack.com/archives/DTESTDM001/p1773477181004799"
  );
});

test("enterprise grid の別 self user id でも direct mention notification を生成できる", () => {
  const event = normalizeDirectMentionNotificationFromRawPayload(
    {
      type: "message",
      subtype: "bot_message",
      channel: "CTESTCHN02",
      text: "<@WTEST0002> テスト2",
      blocks: [
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_section",
              elements: [
                { type: "user", user_id: "WTEST0002" },
                { type: "text", text: " テスト2" },
              ],
            },
          ],
        },
      ],
      team: "TBA5B5CF8",
      event_ts: "1773482514.221889",
      ts: "1773482514.221889",
    },
    {
      selfUserIds: ["UTEST0001", "WTEST0002"],
      workspaceHost: "app.slack.com",
      now: new Date("2026-03-14T19:01:54.000+09:00"),
    }
  );

  assert.ok(event);
  const slack =
    event.detail && "slack" in event.detail
      ? (event.detail.slack as SlackNotificationDetail)
      : undefined;
  assert.equal(slack?.mention_target_user_id, "WTEST0002");
  assert.equal(slack?.is_direct_mention, true);
  assert.equal(slack?.workspace_host, "app.slack.com");
  assert.equal(slack?.permalink, "https://app.slack.com/archives/CTESTCHN02/p1773482514221889");
});

test("既存 notification event に derived field を補完できる", () => {
  const base: NormalizedEvent = {
    schema: "adjutant.event.v1.1",
    uid: "slack:DTESTDM001@1773477181.004799:mention:UTEST0001",
    source: "slack",
    kind: "notification",
    ts: "2026-03-14T17:00:00+09:00",
    detail: {
      slack: {
        channel_id: "DTESTDM001",
        notification_type: "mention",
        message_text: "<@UTEST0001>test",
        user: "UTEST0001",
        event_ts: "1773477181.004799",
      },
    },
  };

  const event = enrichNotificationEvent(base, {
    selfUserIds: ["UTEST0001"],
    workspaceHost: "workspace-alpha.slack.com",
  });
  const slack =
    event.detail && "slack" in event.detail
      ? (event.detail.slack as SlackNotificationDetail)
      : undefined;
  assert.equal(slack?.message_ts, "1773477181.004799");
  assert.equal(slack?.mention_target_user_id, "UTEST0001");
  assert.equal(slack?.is_direct_mention, true);
  assert.equal(slack?.workspace_host, "workspace-alpha.slack.com");
  assert.equal(
    slack?.permalink,
    "https://workspace-alpha.slack.com/archives/DTESTDM001/p1773477181004799"
  );
});

test("v1 notification 判定は mention かつ direct mention のときだけ true", () => {
  const mentionEvent: NormalizedEvent = {
    schema: "adjutant.event.v1.1",
    uid: "slack:C1@1:mention:U1",
    source: "slack",
    kind: "notification",
    ts: "2026-03-14T17:00:00+09:00",
    detail: {
      slack: {
        channel_id: "C1",
        notification_type: "mention",
        message_text: "<@U1> hi",
        user: "bot",
        event_ts: "1.000",
        is_direct_mention: true,
      },
    },
  };
  const botMessageEvent: NormalizedEvent = {
    ...mentionEvent,
    uid: "slack:C1@1:bot_message:U1",
    detail: {
      slack: {
        ...(mentionEvent.detail as { slack: SlackNotificationDetail }).slack,
        notification_type: "bot_message",
      },
    },
  };
  const desktopNotificationEvent: NormalizedEvent = {
    ...mentionEvent,
    uid: "slack:C1@1:desktop_notification:U1",
    detail: {
      slack: {
        ...(mentionEvent.detail as { slack: SlackNotificationDetail }).slack,
        notification_type: "desktop_notification",
      },
    },
  };
  const nonDirectMentionEvent: NormalizedEvent = {
    ...mentionEvent,
    uid: "slack:C1@1:mention:U2",
    detail: {
      slack: {
        ...(mentionEvent.detail as { slack: SlackNotificationDetail }).slack,
        is_direct_mention: false,
      },
    },
  };

  assert.equal(isDirectMentionNotificationEvent(mentionEvent), true);
  assert.equal(isDirectMentionNotificationEvent(botMessageEvent), false);
  assert.equal(isDirectMentionNotificationEvent(desktopNotificationEvent), false);
  assert.equal(isDirectMentionNotificationEvent(nonDirectMentionEvent), false);
});
