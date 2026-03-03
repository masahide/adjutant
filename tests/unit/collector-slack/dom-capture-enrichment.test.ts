import assert from "node:assert/strict";
import test from "node:test";

import type { NormalizedEvent } from "../../../src/core/events.js";
import { enrichReactionEventWithDomCapture } from "../../../src/collector-slack/dom-capture-enrichment.js";

function reactionEvent(): NormalizedEvent {
  return {
    schema: "adjutant.event.v1.1",
    uid: "slack:C123@1730000000.123:thumbsup:added:U123",
    source: "slack",
    kind: "reaction",
    action: "added",
    ts: "2026-03-01T10:00:00.000Z",
    detail: {
      slack: {
        channel_id: "C123",
        message_ts: "1730000000.123",
        emoji: "thumbsup",
      },
    },
  };
}

test("DOM capture success: reaction message_text is補完される", () => {
  const event = reactionEvent();
  const enriched = enrichReactionEventWithDomCapture(event, {
    text: "hello from dom",
    channelId: "C123",
    channelName: "general",
  });

  const slack = (enriched.detail as { slack: Record<string, unknown> }).slack;
  assert.equal(slack.message_text, "hello from dom");
  assert.equal(slack.channel_id, "C123");
  assert.equal(slack.channel_name, "general");
});

test("DOM capture failure: null result のとき event は変更されない", () => {
  const event = reactionEvent();
  const enriched = enrichReactionEventWithDomCapture(event, null);
  assert.equal(enriched, event);
});

test("DOM capture failure: 空テキストしかない結果は無視される", () => {
  const event = reactionEvent();
  const enriched = enrichReactionEventWithDomCapture(event, {
    text: "   ",
  });
  assert.equal(enriched, event);
});

test("non-reaction event は補完対象外", () => {
  const post: NormalizedEvent = {
    schema: "adjutant.event.v1.1",
    uid: "slack:C123@1730000000.123",
    source: "slack",
    kind: "post",
    ts: "2026-03-01T10:00:00.000Z",
    detail: {
      slack: {
        channel_id: "C123",
        text: "hello",
      },
    },
  };

  const enriched = enrichReactionEventWithDomCapture(post, {
    text: "ignored",
  });
  assert.equal(enriched, post);
});
