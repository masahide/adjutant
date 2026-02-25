import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildAgentPrompt,
  resolveAgentRunContext,
  shouldInjectBootstrapContext,
} from "../../src/assistant/agent-prompt-builder.js";

describe("agent-prompt-builder", () => {
  it("run context を正規化する", () => {
    const context = resolveAgentRunContext({
      runId: "r1",
      prompt: "hello",
      sessionKey: "  main ",
      origin: "user",
      timezone: "UTC",
      workspaceDir: "/tmp/workspace",
    });

    assert.equal(context.sessionKey, "main");
    assert.equal(context.memoryScope, "main");
    assert.equal(context.origin, "user");
    assert.equal(context.timezone, "UTC");
    assert.equal(context.workspaceDir, "/tmp/workspace");
  });

  it("memory と bootstrap context を prompt に合成する", () => {
    const prompt = buildAgentPrompt({
      basePrompt: "本文",
      systemPrompt: "システム",
      memory: {
        longTerm: "long-memory",
        daily: "daily-memory",
      },
      bootstrapFiles: [
        {
          name: "BOOTSTRAP.md",
          path: "/tmp/workspace/BOOTSTRAP.md",
          content: "bootstrap-content",
          missing: false,
        },
      ],
    });

    assert.equal(prompt.includes("システム"), true);
    assert.equal(prompt.includes("## Memory\nlong-memory"), true);
    assert.equal(prompt.includes("## Daily Memory\ndaily-memory"), true);
    assert.equal(prompt.includes("# Project Context"), true);
    assert.equal(prompt.includes("## BOOTSTRAP.md"), true);
  });

  it("bootstrap 注入条件を判定する", () => {
    assert.equal(
      shouldInjectBootstrapContext({
        runId: "r",
        prompt: "p",
        sessionKey: "main",
        origin: "user",
        memoryScope: "main",
        isHeartbeat: false,
        memoryWriteEnabled: false,
        workspaceDir: "/tmp",
        timezone: "UTC",
        sessionEntriesPath: "/tmp/sessions.json",
      }),
      true
    );
    assert.equal(
      shouldInjectBootstrapContext({
        runId: "r",
        prompt: "p",
        sessionKey: "main",
        origin: "pipeline",
        memoryScope: "main",
        isHeartbeat: false,
        memoryWriteEnabled: false,
        workspaceDir: "/tmp",
        timezone: "UTC",
        sessionEntriesPath: "/tmp/sessions.json",
      }),
      false
    );
  });

  it("通常ターン向け prompt には HEARTBEAT 指示の適用範囲が明示される", () => {
    const prompt = buildAgentPrompt({
      basePrompt: "本文",
      memory: { longTerm: null, daily: null },
      bootstrapFiles: [
        {
          name: "HEARTBEAT.md",
          path: "/tmp/workspace/HEARTBEAT.md",
          content: "# HEARTBEAT\n- noop",
          missing: false,
        },
      ],
    });

    assert.equal(
      prompt.includes("HEARTBEAT.md instructions apply only during heartbeat turns"),
      true
    );
    assert.equal(
      prompt.includes("For normal user turns, do not execute HEARTBEAT.md instructions."),
      true
    );
  });
});
