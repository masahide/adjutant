import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMarkdownSummaryBatch } from "../../src/assistant/markdown-summary-batch.js";

function toMessageLine(params: {
  role: "user" | "assistant";
  text: string;
  timestamp: string;
  sessionKey?: string;
}): string {
  return JSON.stringify({
    type: "message",
    timestamp: params.timestamp,
    message: {
      role: params.role,
      content: params.text,
      sessionKey: params.sessionKey,
    },
  });
}

describe("markdown-summary-batch", () => {
  it("OpenClaw 準拠で filter 後 slice を適用し command 行を除外する", async () => {
    const root = await mkdtemp(`${tmpdir()}/adjutant-summary-batch-`);
    try {
      const workspaceDir = join(root, "workspace");
      const sessionsDir = join(root, "state", "agents", "main", "sessions");
      const watermarkPath = join(root, "state", "agents", "main", "summary-batch-watermark.json");
      await mkdir(sessionsDir, { recursive: true });
      await mkdir(workspaceDir, { recursive: true });

      const sessionPath = join(sessionsDir, "main.jsonl");
      const lines = [
        toMessageLine({
          role: "user",
          text: "first",
          timestamp: "2026-02-22T10:00:00.000Z",
          sessionKey: "main",
        }),
        JSON.stringify({ type: "tool_use", tool: "search" }),
        toMessageLine({
          role: "assistant",
          text: "second",
          timestamp: "2026-02-22T10:00:01.000Z",
          sessionKey: "main",
        }),
        JSON.stringify({ type: "tool_result", result: "done" }),
        toMessageLine({
          role: "user",
          text: "third",
          timestamp: "2026-02-22T10:00:02.000Z",
          sessionKey: "main",
        }),
        toMessageLine({
          role: "user",
          text: "/new",
          timestamp: "2026-02-22T10:00:03.000Z",
          sessionKey: "main",
        }),
        '{"broken":',
      ];
      await writeFile(sessionPath, `${lines.join("\n")}\n`, "utf8");

      const result = await runMarkdownSummaryBatch({
        workspaceDir,
        timezone: "UTC",
        sessionTranscriptsDir: sessionsDir,
        watermarkPath,
        messages: 2,
        maxSessions: 10,
      });

      assert.equal(result.processedSessions, 1);
      assert.equal(result.writtenEntries, 2);
      assert.equal(result.skippedEntries >= 3, true);

      const daily = await readFile(join(workspaceDir, "memory", "2026-02-22.md"), "utf8");
      assert.equal(daily.includes("assistant: second"), true);
      assert.equal(daily.includes("user: third"), true);
      assert.equal(daily.includes("user: first"), false);
      assert.equal(daily.includes("/new"), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("watermark により同一入力の再実行で重複追記しない", async () => {
    const root = await mkdtemp(`${tmpdir()}/adjutant-summary-batch-`);
    try {
      const workspaceDir = join(root, "workspace");
      const sessionsDir = join(root, "state", "agents", "main", "sessions");
      const watermarkPath = join(root, "state", "agents", "main", "summary-batch-watermark.json");
      await mkdir(sessionsDir, { recursive: true });
      await mkdir(workspaceDir, { recursive: true });

      await writeFile(
        join(sessionsDir, "main.jsonl"),
        `${toMessageLine({
          role: "user",
          text: "hello",
          timestamp: "2026-02-22T11:00:00.000Z",
          sessionKey: "main",
        })}\n`,
        "utf8"
      );

      const first = await runMarkdownSummaryBatch({
        workspaceDir,
        timezone: "UTC",
        sessionTranscriptsDir: sessionsDir,
        watermarkPath,
      });
      assert.equal(first.writtenEntries, 1);

      const firstDaily = await readFile(join(workspaceDir, "memory", "2026-02-22.md"), "utf8");
      const second = await runMarkdownSummaryBatch({
        workspaceDir,
        timezone: "UTC",
        sessionTranscriptsDir: sessionsDir,
        watermarkPath,
      });
      assert.equal(second.writtenEntries, 0);
      const secondDaily = await readFile(join(workspaceDir, "memory", "2026-02-22.md"), "utf8");
      assert.equal(secondDaily, firstDaily);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("state 配下にファイルがなくても legacy workspace/memory/sessions を読める", async () => {
    const root = await mkdtemp(`${tmpdir()}/adjutant-summary-batch-`);
    try {
      const workspaceDir = join(root, "workspace");
      const stateSessionsDir = join(root, "state", "agents", "main", "sessions");
      const legacySessionsDir = join(workspaceDir, "memory", "sessions");
      const watermarkPath = join(root, "state", "agents", "main", "summary-batch-watermark.json");
      await mkdir(stateSessionsDir, { recursive: true });
      await mkdir(legacySessionsDir, { recursive: true });

      await writeFile(
        join(legacySessionsDir, "legacy-main.jsonl"),
        `${toMessageLine({
          role: "assistant",
          text: "legacy message",
          timestamp: "2026-02-21T09:00:00.000Z",
          sessionKey: "legacy-main",
        })}\n`,
        "utf8"
      );

      const result = await runMarkdownSummaryBatch({
        workspaceDir,
        timezone: "UTC",
        sessionTranscriptsDir: stateSessionsDir,
        legacySessionTranscriptsDir: legacySessionsDir,
        watermarkPath,
      });
      assert.equal(result.writtenEntries, 1);

      const daily = await readFile(join(workspaceDir, "memory", "2026-02-21.md"), "utf8");
      assert.equal(daily.includes("assistant: legacy message"), true);
      assert.equal(daily.includes("legacy-main"), true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("出力失敗時は warning を返して処理全体を落とさない", async () => {
    const root = await mkdtemp(`${tmpdir()}/adjutant-summary-batch-`);
    try {
      const brokenWorkspacePath = join(root, "workspace-file");
      await writeFile(brokenWorkspacePath, "not-a-directory", "utf8");
      const sessionsDir = join(root, "state", "agents", "main", "sessions");
      const watermarkPath = join(root, "state", "agents", "main", "summary-batch-watermark.json");
      await mkdir(sessionsDir, { recursive: true });
      await writeFile(
        join(sessionsDir, "main.jsonl"),
        `${toMessageLine({
          role: "user",
          text: "will fail to write",
          timestamp: "2026-02-22T12:00:00.000Z",
          sessionKey: "main",
        })}\n`,
        "utf8"
      );

      const result = await runMarkdownSummaryBatch({
        workspaceDir: brokenWorkspacePath,
        timezone: "UTC",
        sessionTranscriptsDir: sessionsDir,
        watermarkPath,
      });
      assert.equal(result.warnings >= 1, true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
