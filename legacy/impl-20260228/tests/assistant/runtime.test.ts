import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeBackoff, createRuntime } from "../../src/ui/runtime.js";

type MessageEventListener = (event: MessageEvent) => void;

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  closed = false;
  onerror: (() => void) | null = null;
  private readonly listeners = new Map<string, MessageEventListener[]>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: MessageEventListener): void {
    const list = this.listeners.get(type);
    if (list) {
      list.push(listener);
      return;
    }
    this.listeners.set(type, [listener]);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, data: unknown): void {
    const list = this.listeners.get(type) ?? [];
    const event = { data: JSON.stringify(data) } as MessageEvent;
    for (const listener of list) {
      listener(event);
    }
  }

  static reset(): void {
    FakeEventSource.instances = [];
  }
}

async function flushTasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("UI Runtime", () => {
  it("computeBackoff: attempt=1 は initial 付近 (2000ms ± jitter)", () => {
    const values = Array.from({ length: 100 }, () => computeBackoff(1));
    const min = Math.min(...values);
    const max = Math.max(...values);
    assert.ok(min >= 1500, `min ${min} should be >= 1500`);
    assert.ok(max <= 2500, `max ${max} should be <= 2500`);
  });

  it("computeBackoff: attempt が増えると delay も増加する", () => {
    const medians = [1, 3, 5, 8].map((attempt) => {
      const vals = Array.from({ length: 50 }, () => computeBackoff(attempt));
      vals.sort((a, b) => a - b);
      return vals[25];
    });
    for (let i = 1; i < medians.length; i++) {
      assert.ok(
        medians[i] > medians[i - 1],
        `median at attempt ${[1, 3, 5, 8][i]} (${medians[i]}) should be > median at attempt ${[1, 3, 5, 8][i - 1]} (${medians[i - 1]})`
      );
    }
  });

  it("computeBackoff: max を超えない", () => {
    const values = Array.from({ length: 100 }, () => computeBackoff(20));
    const max = Math.max(...values);
    assert.ok(max <= 37500, `max ${max} should be <= 37500 (30000 * 1.25)`);
  });

  it("loadHistory は runId/toolCount を RuntimeMessage に復元する", async () => {
    const originalFetch = globalThis.fetch;
    const originalEventSource = globalThis.EventSource;
    FakeEventSource.reset();
    try {
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/chat/history")) {
          return new Response(
            JSON.stringify({
              messages: [
                {
                  role: "user",
                  content: "## User Message\nこんにちは",
                  timestamp: 100,
                },
                {
                  role: "assistant",
                  content: "回答です",
                  timestamp: 200,
                  runId: "run-history-1",
                  toolCount: 3,
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        throw new Error(`unexpected fetch url: ${url}`);
      }) as typeof fetch;
      globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;

      const runtime = createRuntime("http://runtime.test");
      await runtime.loadHistory("main");
      const state = runtime.getState();
      assert.equal(state.messages.length, 2);
      assert.equal(state.messages[1]?.runId, "run-history-1");
      assert.equal(state.messages[1]?.toolCount, 3);
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.EventSource = originalEventSource;
    }
  });

  it("stream 完了後に runId を保持し audit API から toolCount を補完する", async () => {
    const originalFetch = globalThis.fetch;
    const originalEventSource = globalThis.EventSource;
    FakeEventSource.reset();
    try {
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/chat/messages")) {
          assert.equal(init?.method, "POST");
          return new Response(JSON.stringify({ runId: "run-stream-1" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.endsWith("/api/chat/runs/run-stream-1/audit")) {
          return new Response(
            JSON.stringify({
              runId: "run-stream-1",
              runEnded: true,
              tools: [
                { endedAt: "2026-02-23T10:00:00.100Z" },
                { endedAt: "2026-02-23T10:00:00.200Z" },
              ],
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }
          );
        }
        throw new Error(`unexpected fetch url: ${url}`);
      }) as typeof fetch;
      globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;

      const runtime = createRuntime("http://runtime.test");
      await runtime.sendMessage("hello", "idem-1", "main");
      assert.equal(FakeEventSource.instances.length, 1);
      const es = FakeEventSource.instances[0]!;
      es.emit("chat", {
        runId: "run-stream-1",
        sessionKey: "main",
        seq: 1,
        state: "delta",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "partial " }],
        },
      });
      es.emit("chat", {
        runId: "run-stream-1",
        sessionKey: "main",
        seq: 2,
        state: "final",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "final response" }],
        },
      });

      await flushTasks();
      const state = runtime.getState();
      assert.equal(state.isStreaming, false);
      let assistant: (typeof state.messages)[number] | undefined =
        state.messages[state.messages.length - 1];
      if (assistant?.role !== "assistant") {
        assistant = [...state.messages].reverse().find((message) => message.role === "assistant");
      }
      assert.ok(assistant);
      assert.equal(assistant?.runId, "run-stream-1");
      assert.equal(assistant?.toolCount, 2);
      assert.equal(assistant?.content, "final response");
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.EventSource = originalEventSource;
    }
  });

  it("audit が一時的に空でも再試行で toolCount を確定できる", async () => {
    const originalFetch = globalThis.fetch;
    const originalEventSource = globalThis.EventSource;
    FakeEventSource.reset();
    let auditReads = 0;
    try {
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/chat/messages")) {
          assert.equal(init?.method, "POST");
          return new Response(JSON.stringify({ runId: "run-retry-1" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.endsWith("/api/chat/runs/run-retry-1/audit")) {
          auditReads += 1;
          if (auditReads === 1) {
            return new Response(
              JSON.stringify({
                runId: "run-retry-1",
                runEnded: false,
                tools: [{ endedAt: "2026-02-23T10:00:00.050Z" }],
              }),
              {
                status: 200,
                headers: { "Content-Type": "application/json" },
              }
            );
          }
          return new Response(
            JSON.stringify({
              runId: "run-retry-1",
              runEnded: true,
              tools: [{ endedAt: "2026-02-23T10:00:01.100Z" }],
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }
          );
        }
        throw new Error(`unexpected fetch url: ${url}`);
      }) as typeof fetch;
      globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;

      const runtime = createRuntime("http://runtime.test");
      await runtime.sendMessage("hello", "idem-retry-1", "main");
      const es = FakeEventSource.instances[0]!;
      es.emit("chat", {
        runId: "run-retry-1",
        sessionKey: "main",
        seq: 1,
        state: "final",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 350));
      const state = runtime.getState();
      const assistant = [...state.messages]
        .reverse()
        .find((message) => message.role === "assistant");
      assert.ok(assistant);
      assert.equal(assistant?.runId, "run-retry-1");
      assert.equal(assistant?.toolCount, 1);
      assert.equal(auditReads >= 2, true);
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.EventSource = originalEventSource;
    }
  });
});
