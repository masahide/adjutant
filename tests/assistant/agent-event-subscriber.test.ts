import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCompactionEventTracker } from "../../src/assistant/compaction-runtime.js";
import { createAgentEventSubscriber } from "../../src/assistant/agent-event-subscriber.js";

describe("agent-event-subscriber", () => {
  it("delta と tool イベントを集約し memory_write を実行する", async () => {
    let listener: ((event: unknown) => void) | undefined;
    const memoryWrites: string[] = [];

    const subscription = createAgentEventSubscriber({
      session: {
        subscribe: (cb) => {
          listener = cb;
          return () => undefined;
        },
      },
      runtime: {
        appendDailyMemory: async (content) => {
          memoryWrites.push(`daily:${content}`);
        },
        updateLongTermMemory: async (content) => {
          memoryWrites.push(`long:${content}`);
        },
      },
      memoryWriteEnabled: true,
      workspaceDir: "/tmp/workspace",
      timezone: "UTC",
      compactionTracker: createCompactionEventTracker(0),
      isSilentTurn: () => false,
    });

    listener?.({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Hello " },
    });
    listener?.({
      type: "tool_execution_start",
      toolName: "memory_write",
      args: { scope: "daily", content: "note-1" },
    });
    listener?.({
      type: "tool_execution_end",
      toolName: "memory_write",
      result: { ok: true },
    });
    listener?.({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "World" },
    });

    await subscription.waitForSettledMemoryWrites();

    assert.equal(subscription.output.text, "Hello World");
    assert.deepEqual(memoryWrites, ["daily:note-1"]);
    assert.deepEqual(subscription.toolCalls, [{ name: "memory_write", result: { ok: true } }]);
  });
});
