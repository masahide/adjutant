import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import type { StreamEvent } from "../../src/assistant/types.js";
import type { AgentRunOptions, AgentRunResult } from "../../src/assistant/agent-runner.js";
import { createAgentRunAdapter } from "../../src/assistant/main.adapter.js";

type RunAgentFn = (opts: AgentRunOptions) => Promise<AgentRunResult>;

describe("createAgentRunAdapter", () => {
  const defaultCfg = {
    workspaceDir: "/tmp/workspace",
    timezone: "Asia/Tokyo",
    model: "anthropic/claude-sonnet-4-20250514",
  };

  beforeEach(() => {
    mock.restoreAll();
  });

  it("onTextDelta を delta StreamEvent に変換する", async () => {
    const deltas = ["Hello", " ", "World"];
    const mockRunAgent = mock.fn<RunAgentFn>(async (opts) => {
      for (const d of deltas) {
        opts.onTextDelta?.(d);
      }
      return { runId: "r1", text: "Hello World" };
    });

    const adapter = createAgentRunAdapter(defaultCfg, mockRunAgent);
    const collected: StreamEvent[] = [];
    await adapter({
      prompt: "test",
      sessionKey: "main",
      runId: "r1",
      origin: "user",
      onDelta: (ev) => collected.push(ev),
    });

    // 3 deltas + 1 final = 4 events
    assert.equal(collected.length, 4);

    // Verify delta events
    for (let i = 0; i < 3; i++) {
      assert.equal(collected[i].state, "delta");
      assert.equal(collected[i].runId, "r1");
      assert.equal(collected[i].sessionKey, "main");
      const msg = collected[i].message as {
        role: string;
        content: Array<{ type: string; text: string }>;
      };
      assert.equal(msg.content[0].text, deltas[i]);
    }

    // Verify final event
    const final = collected[3];
    assert.equal(final.state, "final");
    const finalMsg = final.message as {
      role: string;
      content: Array<{ type: string; text: string }>;
    };
    assert.equal(finalMsg.content[0].text, "Hello World");
  });

  it("正常完了時に { status: completed } を返す", async () => {
    const mockRunAgent = mock.fn<RunAgentFn>(async () => {
      return { runId: "r1", text: "done" };
    });

    const adapter = createAgentRunAdapter(defaultCfg, mockRunAgent);
    const result = await adapter({
      prompt: "test",
      sessionKey: "main",
      runId: "r1",
      origin: "user",
      onDelta: () => {},
    });

    assert.equal(result.status, "completed");
  });

  it("エラー時に { status: failed, reason } を返し final は発行しない", async () => {
    const mockRunAgent = mock.fn<RunAgentFn>(async () => {
      throw new Error("LLM timeout");
    });

    const adapter = createAgentRunAdapter(defaultCfg, mockRunAgent);
    const collected: StreamEvent[] = [];
    const result = await adapter({
      prompt: "test",
      sessionKey: "main",
      runId: "r1",
      origin: "user",
      onDelta: (ev) => collected.push(ev),
    });

    assert.equal(result.status, "failed");
    assert.equal(result.reason, "LLM timeout");
    // No final event should be emitted on error
    assert.equal(
      collected.filter((e) => e.state === "final").length,
      0,
      "should not emit final on error"
    );
  });

  it("workspaceDir / timezone / model を runAgent に伝搬する", async () => {
    const mockRunAgent = mock.fn<RunAgentFn>(async () => {
      return { runId: "r1", text: "ok" };
    });

    const adapter = createAgentRunAdapter(
      { workspaceDir: "/my/dir", timezone: "US/Pacific", model: "openai/gpt-4o" },
      mockRunAgent
    );
    await adapter({
      prompt: "hello",
      sessionKey: "sess",
      runId: "r1",
      origin: "user",
      onDelta: () => {},
    });

    assert.equal(mockRunAgent.mock.calls.length, 1);
    const args = mockRunAgent.mock.calls[0].arguments[0];
    assert.equal(args.workspaceDir, "/my/dir");
    assert.equal(args.timezone, "US/Pacific");
    assert.equal(args.model, "openai/gpt-4o");
    assert.equal(args.prompt, "hello");
    assert.equal(args.sessionKey, "sess");
    assert.equal(args.runId, "r1");
    assert.equal(args.origin, "user");
  });

  it("model 未指定の場合は runAgent に渡さない", async () => {
    const mockRunAgent = mock.fn<RunAgentFn>(async () => {
      return { runId: "r1", text: "ok" };
    });

    const adapter = createAgentRunAdapter({ workspaceDir: "/tmp", timezone: "UTC" }, mockRunAgent);
    await adapter({
      prompt: "hello",
      sessionKey: "main",
      runId: "r1",
      origin: "user",
      onDelta: () => {},
    });

    const args = mockRunAgent.mock.calls[0].arguments[0];
    assert.equal(args.model, undefined);
  });

  it("Codex モデルでは sessionId に sessionKey を渡す", async () => {
    const mockRunAgent = mock.fn<RunAgentFn>(async () => {
      return { runId: "r1", text: "ok" };
    });

    const adapter = createAgentRunAdapter(
      { workspaceDir: "/tmp", timezone: "UTC", model: "openai-codex/codex-mini-latest" },
      mockRunAgent
    );
    await adapter({
      prompt: "hello",
      sessionKey: "my-session",
      runId: "r1",
      origin: "user",
      onDelta: () => {},
    });

    const args = mockRunAgent.mock.calls[0].arguments[0];
    assert.equal(args.sessionId, "my-session");
  });

  it("非 Codex モデルでは sessionId を渡さない", async () => {
    const mockRunAgent = mock.fn<RunAgentFn>(async () => {
      return { runId: "r1", text: "ok" };
    });

    const adapter = createAgentRunAdapter(
      { workspaceDir: "/tmp", timezone: "UTC", model: "anthropic/claude-sonnet-4-20250514" },
      mockRunAgent
    );
    await adapter({
      prompt: "hello",
      sessionKey: "main",
      runId: "r1",
      origin: "user",
      onDelta: () => {},
    });

    const args = mockRunAgent.mock.calls[0].arguments[0];
    assert.equal(args.sessionId, undefined);
  });
});
