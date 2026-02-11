import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SlackAdapter } from "../src/slack/adapter.js";
import type { NormalizedEvent } from "../src/core/events.js";
import { createMockSlackClient } from "./mockSlackClient.js";

describe("SlackAdapter event handling", () => {
  it("WebSocketキャッシュとFetchイベントを組み合わせて正規化する", async () => {
    const mock = createMockSlackClient();
    const emitted: NormalizedEvent[] = [];
    const adapter = new SlackAdapter({
      client: mock.client,
      now: () => new Date("2024-03-22T12:45:00Z"),
    });

    await adapter.start(async (ev) => {
      emitted.push(ev);
    });

    await mock.triggerNetwork("webSocketFrameReceived", {
      response: {
        payloadData: JSON.stringify({
          type: "message",
          channel: "C999",
          ts: "1711115555.000600",
          blocks: [{ type: "rich_text", elements: [] }],
          user: "U222",
        }),
      },
    });

    await mock.triggerFetch({
      requestId: "req-2",
      request: {
        url: "https://workspace.slack.com/api/reactions.add",
        method: "POST",
        headers: { "content-type": "application/json" },
        postData: JSON.stringify({
          channel: "C999",
          timestamp: "1711115555.000600",
          name: "thumbsup",
        }),
      },
    });

    assert.equal(emitted.length, 1);
    const reaction = emitted[0];
    assert.equal(reaction.kind, "reaction");
    assert.equal(reaction.action, "added");
    assert.equal(reaction.meta?.emoji, "thumbsup");
    const detail = reaction.detail;
    assert.ok(detail && "slack" in detail);
    const slackDetail = detail.slack as {
      channel_id: string;
      emoji?: string;
      message_text?: string;
    };
    assert.equal(slackDetail.channel_id, "C999");
    assert.equal(slackDetail.emoji, "thumbsup");
    assert.equal(slackDetail.message_text, "");
    assert.equal(reaction.actor, "U222", "WebSocketキャッシュからactorを補完する");
    assert.equal(reaction.uid, "slack:C999@1711115555.000600:thumbsup:added:U222");
  });

  it("WebSocket通知イベントをnotificationとして記録する", async () => {
    const mock = createMockSlackClient();
    const emitted: NormalizedEvent[] = [];
    const adapter = new SlackAdapter({
      client: mock.client,
      now: () => new Date("2024-03-22T12:45:00Z"),
    });

    await adapter.start(async (ev) => {
      emitted.push(ev);
    });

    await mock.triggerNetwork("webSocketFrameReceived", {
      response: {
        payloadData: JSON.stringify({
          type: "desktop_notification",
          channel: "C999",
          channel_name: "general",
          user: "U333",
          ts: "1711117777.000800",
          title: "mention",
          text: "hello from mention",
        }),
      },
    });

    assert.equal(emitted.length, 1);
    const notification = emitted[0];
    assert.equal(notification.kind, "notification");
    assert.equal(notification.meta?.notification_type, "desktop_notification");
    assert.equal(notification.meta?.channel, "#general");
    assert.equal(notification.actor, "U333");
    const detail = notification.detail;
    assert.ok(detail && "slack" in detail);
    const slackDetail = detail.slack as {
      channel_id?: string;
      notification_type?: string;
      title?: string;
      message_text?: string;
    };
    assert.equal(slackDetail.channel_id, "C999");
    assert.equal(slackDetail.notification_type, "desktop_notification");
    assert.equal(slackDetail.title, "mention");
    assert.equal(slackDetail.message_text, "hello from mention");
  });

  it("ネストされた通知payloadをnotificationとして記録する", async () => {
    const mock = createMockSlackClient();
    const emitted: NormalizedEvent[] = [];
    const adapter = new SlackAdapter({
      client: mock.client,
      now: () => new Date("2024-03-22T12:45:00Z"),
    });

    await adapter.start(async (ev) => {
      emitted.push(ev);
    });

    await mock.triggerNetwork("webSocketFrameReceived", {
      response: {
        payloadData: JSON.stringify({
          type: "event_wrapper",
          payload: {
            event: {
              subtype: "mention_notification",
              channel: "C888",
              channel_name: "random",
              user_id: "U444",
              event_ts: "1711118888.000900",
              body: "ping from mention",
            },
          },
        }),
      },
    });

    assert.equal(emitted.length, 1);
    const notification = emitted[0];
    assert.equal(notification.kind, "notification");
    assert.equal(notification.meta?.notification_type, "mention_notification");
    assert.equal(notification.meta?.channel, "#random");
    const detail = notification.detail;
    assert.ok(detail && "slack" in detail);
    const slackDetail = detail.slack as {
      channel_id?: string;
      notification_type?: string;
      message_text?: string;
      user?: string;
    };
    assert.equal(slackDetail.channel_id, "C888");
    assert.equal(slackDetail.notification_type, "mention_notification");
    assert.equal(slackDetail.message_text, "ping from mention");
    assert.equal(slackDetail.user, "U444");
  });
});
