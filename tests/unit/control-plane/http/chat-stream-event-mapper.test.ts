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
        rawInput: { path: "README.md" },
      },
    });
    assert.deepEqual(result, {
      state: "delta",
      runId: "run_5",
      sessionKey: "main",
      toolCallId: "tc_1",
      toolName: "read",
      toolStatus: "started",
      toolInput: { path: "README.md" },
    });
  });

  it("maps tool_call_update to completed with normalized output", () => {
    const result = mapSessionUpdateToChatStreamEvent({
      runId: "run_5b",
      sessionKey: "main",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc_1",
        title: "read",
        status: "completed",
        rawOutput: { ok: true, lines: 3 },
      },
    });
    assert.deepEqual(result, {
      state: "delta",
      runId: "run_5b",
      sessionKey: "main",
      toolCallId: "tc_1",
      toolName: "read",
      toolStatus: "completed",
      toolInput: undefined,
      toolOutput: { ok: true, lines: 3 },
      toolError: undefined,
    });
  });

  it("maps failed update and derives toolError from content text", () => {
    const result = mapSessionUpdateToChatStreamEvent({
      runId: "run_5c",
      sessionKey: "main",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc_1",
        status: "failed",
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: "permission denied",
            },
          },
        ],
      },
    });
    assert.equal(result?.toolStatus, "failed");
    assert.equal(result?.toolError, "permission denied");
  });

  it("normalizes oversized tool payload to truncated string", () => {
    const result = mapSessionUpdateToChatStreamEvent({
      runId: "run_5d",
      sessionKey: "main",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tc_oversized",
        title: "write",
        rawInput: "x".repeat(32 * 1024),
      },
    });
    assert.equal(typeof result?.toolInput, "string");
    assert.equal((result?.toolInput as string).includes("[truncated "), true);
  });

  it("returns undefined for tool_call_update with invalid status", () => {
    const result = mapSessionUpdateToChatStreamEvent({
      runId: "run_5e",
      sessionKey: "main",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc_1",
        status: "unknown_status",
      },
    });
    assert.equal(result, undefined);
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
