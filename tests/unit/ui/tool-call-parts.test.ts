import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAssistantMessageContent,
  mapChatToolEventToState,
  mergeHistoryWithToolEvents,
  toToolCallMessagePart,
  upsertToolCallStates,
} from "../../../src/ui/tool-call-parts.js";

test("tool state merges update-first/start-later without regressing completed status", () => {
  const updateFirst = mapChatToolEventToState({
    seq: 1,
    state: "delta",
    runId: "run_1",
    sessionKey: "main",
    toolCallId: "call_1",
    toolName: "bash",
    toolStatus: "completed",
    toolOutput: { exitCode: 0 },
  });
  const startLater = mapChatToolEventToState({
    seq: 2,
    state: "delta",
    runId: "run_1",
    sessionKey: "main",
    toolCallId: "call_1",
    toolName: "bash",
    toolStatus: "started",
    toolInput: { cmd: "pnpm check" },
  });

  assert.ok(updateFirst);
  assert.ok(startLater);

  let states = upsertToolCallStates([], updateFirst!);
  states = upsertToolCallStates(states, startLater!);

  assert.equal(states.length, 1);
  assert.equal(states[0]?.toolStatus, "completed");
  assert.deepEqual(states[0]?.toolInput, { cmd: "pnpm check" });
  assert.deepEqual(states[0]?.toolOutput, { exitCode: 0 });
});

test("failed tool state is rendered as tool-call part with error result", () => {
  const state = mapChatToolEventToState({
    seq: 1,
    state: "delta",
    runId: "run_1",
    sessionKey: "main",
    toolCallId: "call_2",
    toolName: "read",
    toolStatus: "failed",
    toolInput: { path: "README.md" },
    toolError: "permission denied",
  });
  assert.ok(state);

  const part = toToolCallMessagePart(state!);
  assert.equal(part.type, "tool-call");
  assert.equal(part.toolCallId, "call_2");
  assert.equal(part.isError, true);
  assert.equal(part.result, "permission denied");
  assert.equal((part.argsText ?? "").includes("README.md"), true);
});

test("mergeHistoryWithToolEvents adds tool-call part to assistant message", () => {
  const merged = mergeHistoryWithToolEvents({
    messages: [
      {
        role: "assistant",
        content: "done",
        runId: "run_3",
        timestamp: "2026-03-02T10:00:00.000Z",
      },
    ],
    toolEventsByRun: {
      run_3: [
        {
          runId: "run_3",
          sessionId: "sess_1",
          toolCallId: "call_3",
          status: "completed",
          title: "bash",
          rawInput: { cmd: "echo hi" },
          rawOutput: { stdout: "hi" },
          updatedAt: "2026-03-02T10:00:01.000Z",
        },
      ],
    },
  });

  assert.equal(merged.length, 1);
  assert.equal(Array.isArray(merged[0]?.content), true);
  const content = merged[0]?.content;
  assert.ok(Array.isArray(content));
  assert.equal(
    content?.some((part) => part.type === "tool-call"),
    true
  );
});

test("buildAssistantMessageContent includes thinking, text and tools", () => {
  const content = buildAssistantMessageContent({
    text: "answer",
    thinking: "reasoning",
    toolStates: [
      {
        toolCallId: "call_4",
        toolName: "bash",
        toolStatus: "completed",
        toolInput: { cmd: "pwd" },
        toolOutput: { stdout: "/tmp" },
      },
    ],
  });

  assert.ok(Array.isArray(content));
  assert.equal(content.length, 3);
  assert.equal(content[0]?.type, "reasoning");
  assert.equal(content[1]?.type, "text");
  assert.equal(content[2]?.type, "tool-call");
});
