import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  resolveSlackWorkspaceKey,
  SlackAuthTokenCache,
} from "../../src/slack/slackAuthTokenCache.js";

describe("SlackAuthTokenCache", () => {
  it("初回観測は updated=true で保存し snapshot から参照できる", () => {
    const cache = new SlackAuthTokenCache();

    const result = cache.observe({
      tokenKind: "xoxc",
      value: "xoxc-111-222-333-aaaaaaaaaaaaaaaa",
      sourceStage: "requestWillBeSent",
      requestId: "req-1",
      url: "https://edgeapi.slack.com/cache/T0A93QQUMQW/channels/info",
      observedAt: 1700000000000,
    });

    assert.ok(result);
    assert.equal(result.workspaceKey, "T0A93QQUMQW");
    assert.equal(result.updated, true);
    assert.equal(result.hits, 1);

    const snapshot = cache.snapshot("T0A93QQUMQW");
    assert.ok(snapshot);
    assert.equal(snapshot.tokens.xoxc?.value, "xoxc-111-222-333-aaaaaaaaaaaaaaaa");
    assert.equal(snapshot.tokens.xoxc?.sourceStage, "requestWillBeSent");
  });

  it("同値再観測は updated=false で hits/lastSeenAt のみ更新する", () => {
    const cache = new SlackAuthTokenCache();
    cache.observe({
      tokenKind: "xoxd",
      value: "xoxd-aaa%2Bbbb",
      sourceStage: "requestWillBeSentExtraInfo",
      url: "https://workspace.slack.com/api/chat.postMessage",
      observedAt: 1700000000000,
    });

    const second = cache.observe({
      tokenKind: "xoxd",
      value: "xoxd-aaa%2Bbbb",
      sourceStage: "cookieStoreSnapshot",
      url: "https://workspace.slack.com/api/chat.postMessage",
      observedAt: 1700000001234,
    });

    assert.ok(second);
    assert.equal(second.updated, false);
    assert.equal(second.hits, 2);
    assert.equal(second.firstSeenAt, 1700000000000);
    assert.equal(second.lastSeenAt, 1700000001234);
    assert.equal(second.sourceStage, "requestWillBeSentExtraInfo");
  });

  it("workspaceKey 抽出不能時は global にフォールバックする", () => {
    const cache = new SlackAuthTokenCache();

    const result = cache.observe({
      tokenKind: "xoxd",
      value: "xoxd-unknown",
      sourceStage: "cookieStoreSnapshot",
      url: "not-a-url",
      observedAt: 1700000009999,
    });

    assert.ok(result);
    assert.equal(result.workspaceKey, "global");
    assert.equal(cache.snapshot("global")?.tokens.xoxd?.value, "xoxd-unknown");
  });
});

describe("resolveSlackWorkspaceKey", () => {
  it("slack_route と host を使って workspaceKey を推定する", () => {
    assert.equal(
      resolveSlackWorkspaceKey(
        "https://workspace.slack.com/api/chat.postMessage?slack_route=T0A93QQUMQW:T0A93QQUMQW"
      ),
      "T0A93QQUMQW"
    );
    assert.equal(
      resolveSlackWorkspaceKey("https://ys-family-hq.slack.com/api/chat.postMessage"),
      "ys-family-hq"
    );
  });
});
