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

test.todo("Source 1(session/update): agent_message_chunk -> state=delta に変換する");
test.todo("Source 1(session/update): tool_call -> toolStatus=started に変換する");
test.todo("Source 1(session/update): tool_call_update -> completed/failed に変換する");
test.todo("Source 2(session/prompt): 正常結果 -> state=final に変換する");
test.todo("Source 3(RunLifecycle): failRun -> state=error に変換する");
test.todo("Source 4(PermissionGateway): requested -> permissionRequest に変換する");
test.todo("Source 4(PermissionGateway): resolved -> permissionResolved に変換する");
test.todo("Source 5(user abort): POST /api/chat/abort -> state=aborted に変換する");
