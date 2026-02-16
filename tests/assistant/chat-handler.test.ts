import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as ChatHandler from "../../src/assistant/chat-handler.js";
import * as StreamEventBridge from "../../src/assistant/stream-event-bridge.js";
import type { StreamEvent } from "../../src/assistant/types.js";
import {
  enqueueSystemEvent,
  hasSystemEvents,
  resetSystemEventQueueForTest,
} from "../../src/assistant/system-event-queue.js";
import { resetCommandQueueForTest } from "../../src/assistant/command-queue.js";

function makeStubAgent(
  opts: {
    fail?: boolean;
    delay?: number;
    onPrompt?: (prompt: string) => void;
  } = {}
): ChatHandler.AgentRunFn {
  return async ({ runId, sessionKey, prompt, onDelta }) => {
    opts.onPrompt?.(prompt);
    if (opts.delay) await new Promise((r) => setTimeout(r, opts.delay));
    if (opts.fail) {
      throw new Error("Agent failed");
    }
    onDelta({
      runId,
      sessionKey,
      seq: 0,
      state: "final",
      message: { role: "assistant", content: [{ type: "text", text: "reply" }] },
    } satisfies StreamEvent);
    return { status: "completed" };
  };
}

function makeFailedAgent(): ChatHandler.AgentRunFn {
  return async () => {
    return { status: "failed", reason: "model overloaded" };
  };
}

async function waitForTerminal(runId: string): Promise<StreamEvent> {
  const { events, unsubscribe } = StreamEventBridge.subscribe(runId);
  try {
    for await (const ev of events) {
      if (ev.state === "final" || ev.state === "error" || ev.state === "aborted") {
        return ev;
      }
    }
    throw new Error(`terminal event not received: ${runId}`);
  } finally {
    unsubscribe();
  }
}

describe("ChatHandler", () => {
  beforeEach(() => {
    ChatHandler.resetForTest();
    StreamEventBridge.resetForTest();
    resetSystemEventQueueForTest();
    resetCommandQueueForTest();
    ChatHandler.configure({
      runAgent: makeStubAgent(),
      dataDir: "/tmp/test-data",
      workspaceDir: "/tmp/test-workspace",
      timezone: "Asia/Tokyo",
      idempotencyTtlSec: 300,
    });
  });

  it("acceptMessage は sessionKey 必須バリデーション", () => {
    assert.throws(
      () =>
        ChatHandler.acceptMessage({
          message: "hello",
          sessionKey: "",
          idempotencyKey: "k1",
        }),
      { name: "ValidationError" }
    );
  });

  it("acceptMessage は idempotencyKey 必須バリデーション", () => {
    assert.throws(
      () =>
        ChatHandler.acceptMessage({
          message: "hello",
          sessionKey: "main",
          idempotencyKey: "",
        }),
      { name: "ValidationError" }
    );
  });

  it("acceptMessage は message 必須バリデーション", () => {
    assert.throws(
      () =>
        ChatHandler.acceptMessage({
          message: "",
          sessionKey: "main",
          idempotencyKey: "k1",
        }),
      { name: "ValidationError" }
    );
  });

  it("acceptMessage は新規リクエストで started を返す", () => {
    const res = ChatHandler.acceptMessage({
      message: "hello",
      sessionKey: "main",
      idempotencyKey: "msg-001",
    });
    assert.equal(res.runId, "msg-001");
    assert.equal(res.status, "started");
  });

  it("runId は idempotencyKey と一致する", () => {
    const res = ChatHandler.acceptMessage({
      message: "hello",
      sessionKey: "main",
      idempotencyKey: "my-unique-key",
    });
    assert.equal(res.runId, "my-unique-key");
  });

  it("configure は transcriptLimit なしで受け付ける", () => {
    ChatHandler.resetForTest();
    assert.doesNotThrow(() =>
      ChatHandler.configure({
        runAgent: makeStubAgent(),
        dataDir: "/tmp/test-data",
        workspaceDir: "/tmp/test-workspace",
        timezone: "Asia/Tokyo",
        idempotencyTtlSec: 300,
      })
    );
  });

  it("runAgent への prompt は User Message のみを含む", async () => {
    let capturedPrompt = "";
    ChatHandler.configure({
      runAgent: makeStubAgent({
        onPrompt: (prompt) => {
          capturedPrompt = prompt;
        },
      }),
      dataDir: "/tmp/test-data",
      workspaceDir: "/tmp/test-workspace",
      timezone: "Asia/Tokyo",
      idempotencyTtlSec: 300,
    });

    ChatHandler.acceptMessage({
      message: "hello",
      sessionKey: "main",
      idempotencyKey: "prompt-001",
    });

    const terminal = await waitForTerminal("prompt-001");
    assert.equal(terminal.state, "final");
    assert.equal(capturedPrompt, "## User Message\nhello");
    assert.equal(capturedPrompt.includes("## Recent Session Transcript"), false);
    assert.equal(capturedPrompt.includes("Long-term Memory"), false);
    assert.equal(capturedPrompt.includes("## Daily Memory"), false);
  });

  it("system event は 1 ターンだけ prompt に注入されて drain される", async () => {
    const capturedPrompts: string[] = [];
    ChatHandler.configure({
      runAgent: makeStubAgent({
        onPrompt: (prompt) => {
          capturedPrompts.push(prompt);
        },
      }),
      dataDir: "/tmp/test-data",
      workspaceDir: "/tmp/test-workspace",
      timezone: "Asia/Tokyo",
      idempotencyTtlSec: 300,
    });

    enqueueSystemEvent("workspace changed", { sessionKey: "main" });
    assert.equal(hasSystemEvents("main"), true);

    ChatHandler.acceptMessage({
      message: "hello",
      sessionKey: "main",
      idempotencyKey: "system-event-001",
    });
    const first = await waitForTerminal("system-event-001");
    assert.equal(first.state, "final");
    assert.equal(hasSystemEvents("main"), false);
    assert.equal(
      capturedPrompts[0],
      "## System Events\n- workspace changed\n\n## User Message\nhello"
    );

    ChatHandler.acceptMessage({
      message: "next",
      sessionKey: "main",
      idempotencyKey: "system-event-002",
    });
    const second = await waitForTerminal("system-event-002");
    assert.equal(second.state, "final");
    assert.equal(capturedPrompts[1], "## User Message\nnext");
    assert.equal(capturedPrompts[1].includes("## System Events"), false);
  });

  it("同一 sessionKey + idempotencyKey の再送は冪等処理", () => {
    const first = ChatHandler.acceptMessage({
      message: "hello",
      sessionKey: "main",
      idempotencyKey: "msg-001",
    });
    const second = ChatHandler.acceptMessage({
      message: "hello",
      sessionKey: "main",
      idempotencyKey: "msg-001",
    });
    assert.equal(first.runId, second.runId);
    assert.ok(
      second.status === "in_flight" || second.status === "ok",
      `expected in_flight or ok, got ${second.status}`
    );
  });

  it("異なる sessionKey で同一 idempotencyKey は別 run になる", () => {
    const a = ChatHandler.acceptMessage({
      message: "hello",
      sessionKey: "session-a",
      idempotencyKey: "msg-001",
    });
    const b = ChatHandler.acceptMessage({
      message: "hello",
      sessionKey: "session-b",
      idempotencyKey: "msg-001",
    });
    // runId = idempotencyKey なので同値だが、内部 storeKey が異なるため別 run として処理される
    assert.equal(a.runId, b.runId);
    assert.equal(a.status, "started");
    assert.equal(b.status, "started");
  });

  it("AgentRunner 例外時は error 終端が配信される", async () => {
    ChatHandler.configure({
      runAgent: makeStubAgent({ fail: true }),
      dataDir: "/tmp/test-data",
      workspaceDir: "/tmp/test-workspace",
      timezone: "Asia/Tokyo",
      idempotencyTtlSec: 300,
    });

    ChatHandler.acceptMessage({
      message: "hello",
      sessionKey: "main",
      idempotencyKey: "fail-001",
    });

    const { events, unsubscribe } = StreamEventBridge.subscribe("fail-001");
    const collected: StreamEvent[] = [];
    for await (const ev of events) {
      collected.push(ev);
      if (ev.state === "final" || ev.state === "error" || ev.state === "aborted") break;
    }
    unsubscribe();

    const terminal = collected[collected.length - 1];
    assert.equal(terminal.state, "error");
    assert.equal(terminal.errorMessage, "Agent failed");
  });

  it("AgentRunner が failed を返すと error 終端が配信される", async () => {
    ChatHandler.configure({
      runAgent: makeFailedAgent(),
      dataDir: "/tmp/test-data",
      workspaceDir: "/tmp/test-workspace",
      timezone: "Asia/Tokyo",
      idempotencyTtlSec: 300,
    });

    ChatHandler.acceptMessage({
      message: "hello",
      sessionKey: "main",
      idempotencyKey: "failed-001",
    });

    const { events, unsubscribe } = StreamEventBridge.subscribe("failed-001");
    const collected: StreamEvent[] = [];
    for await (const ev of events) {
      collected.push(ev);
      if (ev.state === "final" || ev.state === "error" || ev.state === "aborted") break;
    }
    unsubscribe();

    const terminal = collected[collected.length - 1];
    assert.equal(terminal.state, "error");
    assert.equal(terminal.errorMessage, "model overloaded");
  });

  it("正常完了で final イベントが配信される", async () => {
    ChatHandler.acceptMessage({
      message: "hello",
      sessionKey: "main",
      idempotencyKey: "ok-001",
    });

    const { events, unsubscribe } = StreamEventBridge.subscribe("ok-001");
    const collected: StreamEvent[] = [];
    for await (const ev of events) {
      collected.push(ev);
      if (ev.state === "final" || ev.state === "error" || ev.state === "aborted") break;
    }
    unsubscribe();

    const terminal = collected[collected.length - 1];
    assert.equal(terminal.state, "final");
  });

  it("abort は実行中 run を中断し aborted 終端を配信する", async () => {
    ChatHandler.configure({
      runAgent: makeStubAgent({ delay: 5000 }),
      dataDir: "/tmp/test-data",
      workspaceDir: "/tmp/test-workspace",
      timezone: "Asia/Tokyo",
      idempotencyTtlSec: 300,
    });

    ChatHandler.acceptMessage({
      message: "hello",
      sessionKey: "main",
      idempotencyKey: "abort-001",
    });

    const result = ChatHandler.abort({ sessionKey: "main", runId: "abort-001" });
    assert.equal(result.ok, true);
    assert.equal(result.aborted, 1);
    assert.deepEqual(result.runIds, ["abort-001"]);

    // Verify terminal event was emitted
    const terminal = StreamEventBridge.getTerminal("abort-001");
    assert.notEqual(terminal, null);
    assert.equal(terminal?.state, "aborted");
    assert.equal(terminal?.errorMessage, "Aborted by user");
  });

  it("abort (sessionKey のみ) は全実行中 run を中断する", () => {
    ChatHandler.configure({
      runAgent: makeStubAgent({ delay: 5000 }),
      dataDir: "/tmp/test-data",
      workspaceDir: "/tmp/test-workspace",
      timezone: "Asia/Tokyo",
      idempotencyTtlSec: 300,
    });

    ChatHandler.acceptMessage({
      message: "hello",
      sessionKey: "main",
      idempotencyKey: "a1",
    });
    ChatHandler.acceptMessage({
      message: "hello",
      sessionKey: "main",
      idempotencyKey: "a2",
    });

    const result = ChatHandler.abort({ sessionKey: "main" });
    assert.equal(result.ok, true);
    assert.equal(result.aborted, 2);
  });
});
