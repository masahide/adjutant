import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NormalizedEvent } from "../../src/core/events.js";
import {
  resolveAccountId,
  resolveAgentRoute,
  resolveQueueKey,
  resolveThreadSessionKeys,
} from "../../src/proactive/session-route-resolver.js";

function makeEvent(meta?: Record<string, unknown>): NormalizedEvent {
  return {
    schema: "adjutant.event.v1.1",
    uid: "uid-1",
    source: "slack",
    kind: "post",
    ts: "2026-02-17T00:00:00+09:00",
    meta,
  };
}

describe("session-route-resolver", () => {
  it("accountId 解決順: event.meta.account_id > configured > default", () => {
    const fromMeta = resolveAccountId({
      event: makeEvent({ account_id: "meta-account" }),
      configuredDefaultAccountId: "configured-account",
    });
    const fromConfigured = resolveAccountId({
      event: makeEvent(),
      configuredDefaultAccountId: "configured-account",
    });
    const fromDefault = resolveAccountId({
      event: makeEvent(),
    });

    assert.equal(fromMeta, "meta-account");
    assert.equal(fromConfigured, "configured-account");
    assert.equal(fromDefault, "default");
  });

  it("sessionKey 解決: D/G/C で prefix を切り替える", () => {
    assert.equal(
      resolveThreadSessionKeys({ accountId: "a", channelId: "D123" }).sessionKey,
      "slack:D123"
    );
    assert.equal(
      resolveThreadSessionKeys({ accountId: "a", channelId: "G123" }).sessionKey,
      "slack:group:G123"
    );
    assert.equal(
      resolveThreadSessionKeys({ accountId: "a", channelId: "C123" }).sessionKey,
      "slack:channel:C123"
    );
  });

  it("threadTs があれば sessionKey に thread suffix を付与する", () => {
    const resolved = resolveThreadSessionKeys({
      accountId: "a",
      channelId: "C777",
      threadTs: "1741000000.000200",
    });
    assert.equal(resolved.baseSessionKey, "slack:channel:C777");
    assert.equal(resolved.parentSessionKey, "slack:channel:C777");
    assert.equal(resolved.sessionKey, "slack:channel:C777:thread:1741000000.000200");
  });

  it("runTarget=main は main session へ、session は origin へ解決する", () => {
    const main = resolveAgentRoute({
      runTarget: "main",
      mainSessionKey: "main",
      originSessionKey: "slack:channel:C1",
    });
    const session = resolveAgentRoute({
      runTarget: "session",
      mainSessionKey: "main",
      originSessionKey: "slack:channel:C1",
    });
    assert.equal(main.sessionKey, "main");
    assert.equal(main.originSessionKey, "slack:channel:C1");
    assert.equal(session.sessionKey, "slack:channel:C1");
  });

  it("queue key は thread/sender 欠落時にフォールバックする", () => {
    const key = resolveQueueKey({
      accountId: "acc-1",
      sessionKey: "slack:channel:C1",
      channelKey: "C1",
    });
    assert.equal(key, "acc-1:slack:channel:C1:unknown-sender:channel:C1");
  });
});
