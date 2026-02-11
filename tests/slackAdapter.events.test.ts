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
});
