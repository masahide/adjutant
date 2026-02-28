import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChannelNotificationInput } from "../../src/proactive/channel-plugin.js";
import { createRuleTriage } from "../../src/proactive/rule-triage.js";

function createPostInput(params: {
  uid: string;
  channelId: string;
  text?: string;
}): ChannelNotificationInput {
  return {
    accountId: "acc-1",
    channelId: "slack",
    event: {
      schema: "adjutant.event.v1.1",
      uid: params.uid,
      source: "slack",
      kind: "post",
      ts: "2026-02-22T10:30:00.000Z",
      actor: "U111",
      detail: {
        slack: {
          channel_id: params.channelId,
          text: params.text ?? "hello",
          message_ts: "1740000000.000100",
        },
      },
    },
  };
}

describe("rule-triage", () => {
  it("self message は drop する", () => {
    const triage = createRuleTriage();
    const result = triage.classify({
      event: createPostInput({ uid: "uid-self", channelId: "C123" }).event,
      selfState: "self",
    });
    assert.equal(result.route, "drop");
  });

  it("DM は immediate で分類する", () => {
    const triage = createRuleTriage();
    const result = triage.classify({
      event: createPostInput({ uid: "uid-dm", channelId: "D123" }).event,
      selfState: "non-self",
    });
    assert.equal(result.route, "immediate");
    assert.equal(result.isDm, true);
  });

  it("mention を含む channel post は immediate で分類する", () => {
    const triage = createRuleTriage();
    const result = triage.classify({
      event: createPostInput({
        uid: "uid-mention",
        channelId: "C123",
        text: "確認お願いします @you",
      }).event,
      selfState: "non-self",
    });
    assert.equal(result.route, "immediate");
  });

  it("通常 channel post は accumulate で分類する", () => {
    const triage = createRuleTriage();
    const result = triage.classify({
      event: createPostInput({
        uid: "uid-channel",
        channelId: "C123",
        text: "デプロイ完了しました",
      }).event,
      selfState: "non-self",
    });
    assert.equal(result.route, "accumulate");
  });
});
