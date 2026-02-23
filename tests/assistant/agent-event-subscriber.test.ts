import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCompactionEventTracker } from "../../src/assistant/compaction-runtime.js";
import {
  configureAgentAuditLogger,
  flushAgentAuditLoggerForTest,
  resetAgentAuditLoggerForTest,
} from "../../src/assistant/agent-audit.js";
import { createAgentEventSubscriber } from "../../src/assistant/agent-event-subscriber.js";

describe("agent-event-subscriber", () => {
  afterEach(() => {
    resetAgentAuditLoggerForTest();
  });

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
      auditScope: { runId: "run-1", sessionKey: "main" },
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

  it("tool.start/tool.end を監査ログへ出力する", async () => {
    let listener: ((event: unknown) => void) | undefined;
    const tempDir = await mkdtemp(`${tmpdir()}/adjutant-agent-event-subscriber-`);
    try {
      const auditPath = join(tempDir, "audit", "agent-audit.ndjson");
      configureAgentAuditLogger({
        enabled: true,
        path: auditPath,
        maxFieldChars: 4000,
      });
      const subscription = createAgentEventSubscriber({
        session: {
          subscribe: (cb) => {
            listener = cb;
            return () => undefined;
          },
        },
        runtime: {
          appendDailyMemory: async () => undefined,
          updateLongTermMemory: async () => undefined,
        },
        memoryWriteEnabled: true,
        workspaceDir: "/tmp/workspace",
        timezone: "UTC",
        auditScope: { runId: "run-ev-1", sessionKey: "main" },
        compactionTracker: createCompactionEventTracker(0),
        isSilentTurn: () => false,
      });

      listener?.({
        type: "tool_execution_start",
        toolName: "memory_search",
        args: { query: "policy", apiKey: "secret" },
      });
      listener?.({
        type: "tool_execution_end",
        toolName: "memory_search",
        result: { results: [] },
      });

      await subscription.waitForSettledMemoryWrites();
      await flushAgentAuditLoggerForTest();

      const events = (await readFile(auditPath, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { type: string; args?: Record<string, unknown> });
      assert.deepEqual(
        events.map((event) => event.type),
        ["tool.start", "tool.end"]
      );
      assert.deepEqual(events[0]?.args, { query: "policy", apiKey: "***" });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
