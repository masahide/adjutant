import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeSlackMessage } from "../src/slack/normalize.js";

describe("normalizeSlackMessage", () => {
  it("SlackメッセージをNormalizedEventへ変換する", () => {
    const normalized = normalizeSlackMessage(
      {
        channel: { id: "C123", name: "dev-infra" },
        user: { id: "U999", name: "yamazaki" },
        ts: "1711111111.000200",
        text: "テストメッセージ",
        blocks: [{ type: "rich_text", elements: [] }],
        thread_ts: undefined,
      },
      { now: new Date("2024-03-22T12:40:00Z") }
    );

    assert.equal(normalized.schema, "reaclog.event.v1.1");
    assert.equal(normalized.source, "slack");
    assert.equal(normalized.kind, "post");
    assert.equal(normalized.uid, "slack:C123@1711111111.000200");
    assert.equal(normalized.actor, "yamazaki");
    assert.equal(normalized.meta?.channel, "#dev-infra");
    const detail = normalized.detail;
    assert.ok(detail && "slack" in detail);
    const slackDetail = detail.slack as {
      channel_id: string;
      channel_name?: string;
      text?: string;
      message_ts?: string;
    };
    assert.equal(slackDetail.channel_id, "C123");
    assert.equal(slackDetail.channel_name, "dev-infra");
    assert.equal(slackDetail.text, "テストメッセージ");
    assert.equal(slackDetail.message_ts, "1711111111.000200");
    assert.equal(normalized.ts, "2024-03-22T21:38:31+09:00");
    assert.equal(normalized.logged_at, "2024-03-22T21:40:00+09:00");
  });
});
