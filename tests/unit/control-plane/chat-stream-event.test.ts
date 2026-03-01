import assert from "node:assert/strict";
import test from "node:test";

import {
  CHAT_STREAM_STATES,
  type ChatStreamEvent,
  type ThreadRecord,
} from "../../../src/control-plane/contracts/http-api.js";

test("ChatStreamEvent の state 定義が契約どおりである", () => {
  assert.deepEqual(CHAT_STREAM_STATES, ["delta", "final", "aborted", "error"]);
});

test("ThreadRecord の必須フィールドを満たす最小データを表現できる", () => {
  const record: ThreadRecord = {
    threadId: "main",
    title: "Main",
    archived: false,
    isDefault: true,
    createdAt: "1970-01-01T00:00:00.000Z",
    updatedAt: "1970-01-01T00:00:00.000Z",
  };
  assert.equal(record.threadId, "main");
});

test("ChatStreamEvent の最小 delta イベントを表現できる", () => {
  const event: ChatStreamEvent = {
    seq: 1,
    state: "delta",
    runId: "session:sess_1:run:1",
    sessionKey: "main",
    message: "hello",
  };
  assert.equal(event.state, "delta");
});
