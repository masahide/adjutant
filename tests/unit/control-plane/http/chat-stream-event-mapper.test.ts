import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  mapSessionUpdateToChatStreamEvent,
  mapPromptResultToChatStreamEvent,
  mapAbortToChatStreamEvent,
  mapRunFailureToChatStreamEvent,
} from "../../../../src/control-plane/http/chat-stream-event-mapper.js";

describe("mapSessionUpdateToChatStreamEvent", () => {
  it("maps agent_message_chunk to delta with message", () => {
    const result = mapSessionUpdateToChatStreamEvent({
      runId: "run_1",
      sessionKey: "main",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello" },
      },
    });
    assert.deepEqual(result, {
      state: "delta",
      runId: "run_1",
      sessionKey: "main",
      message: "hello",
    });
  });

  it("maps agent_thinking_chunk to delta with thinking", () => {
    const result = mapSessionUpdateToChatStreamEvent({
      runId: "run_2",
      sessionKey: "main",
      update: {
        sessionUpdate: "agent_thinking_chunk",
        content: { type: "text", text: "let me think..." },
      },
    });
    assert.deepEqual(result, {
      state: "delta",
      runId: "run_2",
      sessionKey: "main",
      thinking: "let me think...",
    });
  });

  it("maps agent_thinking_chunk with empty text to delta with empty thinking", () => {
    const result = mapSessionUpdateToChatStreamEvent({
      runId: "run_3",
      sessionKey: "main",
      update: {
        sessionUpdate: "agent_thinking_chunk",
        content: { type: "text", text: "" },
      },
    });
    assert.deepEqual(result, {
      state: "delta",
      runId: "run_3",
      sessionKey: "main",
      thinking: "",
    });
  });

  it("maps agent_thinking_chunk with missing content to delta with empty thinking", () => {
    const result = mapSessionUpdateToChatStreamEvent({
      runId: "run_4",
      sessionKey: "main",
      update: {
        sessionUpdate: "agent_thinking_chunk",
      },
    });
    assert.deepEqual(result, {
      state: "delta",
      runId: "run_4",
      sessionKey: "main",
      thinking: "",
    });
  });

  it("maps tool_call to delta with toolStatus started", () => {
    const result = mapSessionUpdateToChatStreamEvent({
      runId: "run_5",
      sessionKey: "main",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tc_1",
        title: "read",
        kind: "read",
      },
    });
    assert.deepEqual(result, {
      state: "delta",
      runId: "run_5",
      sessionKey: "main",
      toolCallId: "tc_1",
      toolName: "read",
      toolStatus: "started",
    });
  });

  it("returns undefined for unknown sessionUpdate type", () => {
    const result = mapSessionUpdateToChatStreamEvent({
      runId: "run_6",
      sessionKey: "main",
      update: {
        sessionUpdate: "unknown_type",
      },
    });
    assert.equal(result, undefined);
  });
});

describe("mapPromptResultToChatStreamEvent", () => {
  it("produces a final event", () => {
    const result = mapPromptResultToChatStreamEvent({
      runId: "run_1",
      sessionKey: "main",
      text: "done",
    });
    assert.deepEqual(result, {
      state: "final",
      runId: "run_1",
      sessionKey: "main",
      message: "done",
    });
  });
});

describe("mapAbortToChatStreamEvent", () => {
  it("produces an aborted event", () => {
    const result = mapAbortToChatStreamEvent({
      runId: "run_1",
      sessionKey: "main",
    });
    assert.deepEqual(result, {
      state: "aborted",
      runId: "run_1",
      sessionKey: "main",
    });
  });
});

describe("mapRunFailureToChatStreamEvent", () => {
  it("produces an error event", () => {
    const result = mapRunFailureToChatStreamEvent({
      runId: "run_1",
      sessionKey: "main",
      summary: { errorCode: "INTERNAL", errorMessage: "something broke" },
    });
    assert.deepEqual(result, {
      state: "error",
      runId: "run_1",
      sessionKey: "main",
      errorMessage: "INTERNAL: something broke",
    });
  });
});
