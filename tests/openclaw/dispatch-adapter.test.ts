import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NormalizedEvent } from "../../src/core/events.js";
import { toApiRequest, toChatDispatchRequest } from "../../src/openclaw/dispatch-adapter.js";

function makePostEvent(params: {
  uid: string;
  channelId?: string;
  messageTs?: string;
  text?: string;
  threadTs?: string;
}): NormalizedEvent {
  return {
    schema: "adjutant.event.v1.1",
    uid: params.uid,
    source: "slack",
    kind: "post",
    ts: "2026-02-17T00:00:00+09:00",
    detail: {
      slack: {
        channel_id: params.channelId ?? "C100",
        message_ts: params.messageTs ?? "1740000000.000100",
        text: params.text,
        thread_ts: params.threadTs,
      },
    },
  };
}

function makeReactionEvent(uid: string): NormalizedEvent {
  return {
    schema: "adjutant.event.v1.1",
    uid,
    source: "slack",
    kind: "reaction",
    ts: "2026-02-17T00:00:00+09:00",
    detail: {
      slack: {
        channel_id: "C100",
        message_ts: "1740000000.000100",
      },
    },
  };
}

describe("dispatch-adapter", () => {
  it("必須フィールド不足を拒否する", () => {
    assert.throws(
      () =>
        toChatDispatchRequest({ accountId: "", events: [makePostEvent({ uid: "u1", text: "a" })] }),
      /accountId is required/
    );
    assert.throws(
      () => toChatDispatchRequest({ accountId: "acc-1", events: [] }),
      /events is required/
    );
    assert.throws(
      () =>
        toChatDispatchRequest({
          accountId: "acc-1",
          events: [makePostEvent({ uid: "u1", text: "" })],
        }),
      /dispatch message is empty/
    );
  });

  it("uid ソート済み集合で idempotencyKey を生成し、API request に変換できる", () => {
    const dispatch = toChatDispatchRequest({
      accountId: "acc-1",
      events: [
        makePostEvent({ uid: "u-b", text: "world" }),
        makePostEvent({ uid: "u-a", text: "hello" }),
      ],
      originSessionKey: "slack:channel:C100",
      runTarget: "session",
    });

    assert.equal(dispatch.sessionKey, "slack:channel:C100");
    assert.deepEqual(dispatch.eventUids, ["u-a", "u-b"]);
    assert.ok(dispatch.idempotencyKey.startsWith("sha256:"));
    assert.equal(dispatch.message, "world\nhello");

    const apiRequest = toApiRequest(dispatch);
    assert.deepEqual(apiRequest, {
      message: "world\nhello",
      sessionKey: "slack:channel:C100",
      idempotencyKey: dispatch.idempotencyKey,
    });
  });

  it("maxDispatchChars / maxEventUidsPerDispatch 超過時に truncation と overflow を付与する", () => {
    const dispatch = toChatDispatchRequest({
      accountId: "acc-1",
      originSessionKey: "slack:channel:C100",
      runTarget: "main",
      mainSessionKey: "main",
      maxDispatchChars: 20,
      maxEventUidsPerDispatch: 2,
      events: [
        makePostEvent({ uid: "u-1", text: "1234567890" }),
        makePostEvent({ uid: "u-2", text: "abcdefghij" }),
        makeReactionEvent("u-3"),
      ],
    });

    assert.equal(dispatch.sessionKey, "main");
    assert.equal(dispatch.messageTruncated, true);
    assert.equal(typeof dispatch.originalCharCount, "number");
    assert.equal(typeof dispatch.dispatchedCharCount, "number");
    assert.equal(dispatch.eventUids.length, 2);
    assert.equal(dispatch.uidOverflowCount, 1);
  });

  it("post 由来の messageIds を抽出する", () => {
    const dispatch = toChatDispatchRequest({
      accountId: "acc-1",
      originSessionKey: "slack:channel:C100",
      events: [
        makePostEvent({ uid: "u-1", text: "hello", messageTs: "1.1" }),
        makePostEvent({ uid: "u-2", text: "world", messageTs: "2.2" }),
      ],
    });

    assert.deepEqual(dispatch.messageIds, ["1.1", "2.2"]);
  });
});
