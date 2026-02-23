import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMarkdownSummaryBatchService,
  runMarkdownSummaryBatch,
} from "../../src/assistant/markdown-summary-batch.js";

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
      assert.equal(result.skippedEntries, 4);

      const daily = await readFile(join(workspaceDir, "memory", "2026-02-22.md"), "utf8");
      assert.equal(daily.includes("assistant: second"), true);
      assert.equal(daily.includes("user: third"), true);
      assert.equal(daily.includes("user: first"), false);
      assert.equal(daily.includes("/new"), false);

      const watermark = JSON.parse(await readFile(watermarkPath, "utf8")) as {
        sessions?: Record<string, unknown>;
      };
      assert.equal(Boolean(watermark.sessions?.["state:main.jsonl"]), true);
      assert.equal(
        Object.keys(watermark.sessions ?? {}).some((key) => key.startsWith("/")),
        false
      );
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

  it("legacy workspace/memory/sessions は参照せず state 配下のみを処理する", async () => {
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
        watermarkPath,
      });
      assert.equal(result.writtenEntries, 0);
      await assert.rejects(readFile(join(workspaceDir, "memory", "2026-02-21.md"), "utf8"));
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

  it("service runOnce は override で実行時オプションを差し替えられる", async () => {
    const root = await mkdtemp(`${tmpdir()}/adjutant-summary-batch-`);
    try {
      const workspaceA = join(root, "workspace-a");
      const workspaceB = join(root, "workspace-b");
      const sessionsDir = join(root, "state", "agents", "main", "sessions");
      const watermarkPath = join(root, "state", "agents", "main", "summary-batch-watermark.json");
      await mkdir(workspaceA, { recursive: true });
      await mkdir(workspaceB, { recursive: true });
      await mkdir(sessionsDir, { recursive: true });
      await writeFile(
        join(sessionsDir, "main.jsonl"),
        `${toMessageLine({
          role: "user",
          text: "service-override",
          timestamp: "2026-02-22T12:30:00.000Z",
          sessionKey: "main",
        })}\n`,
        "utf8"
      );

      const service = createMarkdownSummaryBatchService({
        workspaceDir: workspaceA,
        timezone: "UTC",
        sessionTranscriptsDir: sessionsDir,
        watermarkPath,
      });
      await service.runOnce({ workspaceDir: workspaceB });

      const daily = await readFile(join(workspaceB, "memory", "2026-02-22.md"), "utf8");
      assert.equal(daily.includes("service-override"), true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("transcript truncate 後に offset をリセットして再処理できる", async () => {
    const root = await mkdtemp(`${tmpdir()}/adjutant-summary-batch-`);
    try {
      const workspaceDir = join(root, "workspace");
      const sessionsDir = join(root, "state", "agents", "main", "sessions");
      const watermarkPath = join(root, "state", "agents", "main", "summary-batch-watermark.json");
      const sessionPath = join(sessionsDir, "main.jsonl");
      await mkdir(sessionsDir, { recursive: true });
      await mkdir(workspaceDir, { recursive: true });

      await writeFile(
        sessionPath,
        [
          toMessageLine({
            role: "user",
            text: "before truncate with a much longer message to force larger file size",
            timestamp: "2026-02-22T13:00:00.000Z",
            sessionKey: "main",
          }),
        ].join("\n") + "\n",
        "utf8"
      );
      await runMarkdownSummaryBatch({
        workspaceDir,
        timezone: "UTC",
        sessionTranscriptsDir: sessionsDir,
        watermarkPath,
      });

      await writeFile(
        sessionPath,
        [
          toMessageLine({
            role: "assistant",
            text: "after truncate",
            timestamp: "2026-02-22T13:05:00.000Z",
            sessionKey: "main",
          }),
        ].join("\n") + "\n",
        "utf8"
      );
      const second = await runMarkdownSummaryBatch({
        workspaceDir,
        timezone: "UTC",
        sessionTranscriptsDir: sessionsDir,
        watermarkPath,
      });
      assert.equal(second.writtenEntries, 1);
      const daily = await readFile(join(workspaceDir, "memory", "2026-02-22.md"), "utf8");
      assert.equal(daily.includes("assistant: after truncate"), true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("maxSessions 制限下でも未処理ファイルが飢餓しない", async () => {
    const root = await mkdtemp(`${tmpdir()}/adjutant-summary-batch-`);
    try {
      const workspaceDir = join(root, "workspace");
      const sessionsDir = join(root, "state", "agents", "main", "sessions");
      const watermarkPath = join(root, "state", "agents", "main", "summary-batch-watermark.json");
      await mkdir(sessionsDir, { recursive: true });
      await mkdir(workspaceDir, { recursive: true });

      await writeFile(
        join(sessionsDir, "a.jsonl"),
        `${toMessageLine({
          role: "user",
          text: "from-a",
          timestamp: "2026-02-22T14:00:00.000Z",
          sessionKey: "a",
        })}\n`,
        "utf8"
      );
      await writeFile(
        join(sessionsDir, "b.jsonl"),
        `${toMessageLine({
          role: "user",
          text: "from-b",
          timestamp: "2026-02-22T14:00:01.000Z",
          sessionKey: "b",
        })}\n`,
        "utf8"
      );
      await writeFile(
        join(sessionsDir, "c.jsonl"),
        `${toMessageLine({
          role: "user",
          text: "from-c",
          timestamp: "2026-02-22T14:00:02.000Z",
          sessionKey: "c",
        })}\n`,
        "utf8"
      );

      await runMarkdownSummaryBatch({
        workspaceDir,
        timezone: "UTC",
        sessionTranscriptsDir: sessionsDir,
        watermarkPath,
        maxSessions: 1,
        now: new Date("2026-02-22T14:10:00.000Z"),
      });
      await runMarkdownSummaryBatch({
        workspaceDir,
        timezone: "UTC",
        sessionTranscriptsDir: sessionsDir,
        watermarkPath,
        maxSessions: 1,
        now: new Date("2026-02-22T14:11:00.000Z"),
      });
      await runMarkdownSummaryBatch({
        workspaceDir,
        timezone: "UTC",
        sessionTranscriptsDir: sessionsDir,
        watermarkPath,
        maxSessions: 1,
        now: new Date("2026-02-22T14:12:00.000Z"),
      });

      const daily = await readFile(join(workspaceDir, "memory", "2026-02-22.md"), "utf8");
      assert.equal(daily.includes("from-a"), true);
      assert.equal(daily.includes("from-b"), true);
      assert.equal(daily.includes("from-c"), true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("日付セグメント途中で失敗しても成功済み分の重複を抑止する", async () => {
    const root = await mkdtemp(`${tmpdir()}/adjutant-summary-batch-`);
    try {
      const workspaceDir = join(root, "workspace");
      const sessionsDir = join(root, "state", "agents", "main", "sessions");
      const watermarkPath = join(root, "state", "agents", "main", "summary-batch-watermark.json");
      const sessionPath = join(sessionsDir, "main.jsonl");
      const memoryDir = join(workspaceDir, "memory");
      await mkdir(sessionsDir, { recursive: true });
      await mkdir(memoryDir, { recursive: true });

      await writeFile(
        sessionPath,
        [
          toMessageLine({
            role: "user",
            text: "day-1",
            timestamp: "2026-02-22T23:59:00.000Z",
            sessionKey: "main",
          }),
          toMessageLine({
            role: "assistant",
            text: "day-2",
            timestamp: "2026-02-23T00:01:00.000Z",
            sessionKey: "main",
          }),
        ].join("\n") + "\n",
        "utf8"
      );

      await mkdir(join(memoryDir, "2026-02-23.md"), { recursive: true });
      const first = await runMarkdownSummaryBatch({
        workspaceDir,
        timezone: "UTC",
        sessionTranscriptsDir: sessionsDir,
        watermarkPath,
      });
      assert.equal(first.warnings >= 1, true);

      const day1Before = await readFile(join(memoryDir, "2026-02-22.md"), "utf8");
      const day1CountBefore = day1Before.split("day-1").length - 1;
      assert.equal(day1CountBefore, 1);

      await rm(join(memoryDir, "2026-02-23.md"), { recursive: true, force: true });
      const second = await runMarkdownSummaryBatch({
        workspaceDir,
        timezone: "UTC",
        sessionTranscriptsDir: sessionsDir,
        watermarkPath,
      });
      assert.equal(second.writtenEntries, 1);

      const day1After = await readFile(join(memoryDir, "2026-02-22.md"), "utf8");
      const day1CountAfter = day1After.split("day-1").length - 1;
      assert.equal(day1CountAfter, 1);

      const day2 = await readFile(join(memoryDir, "2026-02-23.md"), "utf8");
      assert.equal(day2.includes("day-2"), true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("末尾改行なし JSONL の最終行も処理できる", async () => {
    const root = await mkdtemp(`${tmpdir()}/adjutant-summary-batch-`);
    try {
      const workspaceDir = join(root, "workspace");
      const sessionsDir = join(root, "state", "agents", "main", "sessions");
      const watermarkPath = join(root, "state", "agents", "main", "summary-batch-watermark.json");
      await mkdir(workspaceDir, { recursive: true });
      await mkdir(sessionsDir, { recursive: true });

      await writeFile(
        join(sessionsDir, "main.jsonl"),
        toMessageLine({
          role: "user",
          text: "no-newline-tail",
          timestamp: "2026-02-24T00:00:00.000Z",
          sessionKey: "main",
        }),
        "utf8"
      );

      const result = await runMarkdownSummaryBatch({
        workspaceDir,
        timezone: "UTC",
        sessionTranscriptsDir: sessionsDir,
        watermarkPath,
      });
      assert.equal(result.writtenEntries, 1);

      const daily = await readFile(join(workspaceDir, "memory", "2026-02-24.md"), "utf8");
      assert.equal(daily.includes("no-newline-tail"), true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
