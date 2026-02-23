import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMessages, loadRecentSessionEvents } from "../../src/assistant/transcript-reader.js";

type EnvSnapshot = {
  sessionEntriesPath?: string;
  transcriptsDir?: string;
  agentAuditLogPath?: string;
};

function snapshotEnv(): EnvSnapshot {
  return {
    sessionEntriesPath: process.env.ADJUTANT_SESSION_ENTRIES_PATH,
    transcriptsDir: process.env.ADJUTANT_TRANSCRIPTS_DIR,
    agentAuditLogPath: process.env.ADJUTANT_AGENT_AUDIT_LOG_PATH,
  };
}

function restoreEnv(snapshot: EnvSnapshot): void {
  if (snapshot.sessionEntriesPath === undefined) {
    delete process.env.ADJUTANT_SESSION_ENTRIES_PATH;
  } else {
    process.env.ADJUTANT_SESSION_ENTRIES_PATH = snapshot.sessionEntriesPath;
  }

  if (snapshot.transcriptsDir === undefined) {
    delete process.env.ADJUTANT_TRANSCRIPTS_DIR;
  } else {
    process.env.ADJUTANT_TRANSCRIPTS_DIR = snapshot.transcriptsDir;
  }

  if (snapshot.agentAuditLogPath === undefined) {
    delete process.env.ADJUTANT_AGENT_AUDIT_LOG_PATH;
  } else {
    process.env.ADJUTANT_AGENT_AUDIT_LOG_PATH = snapshot.agentAuditLogPath;
  }
}

describe("TranscriptReader", () => {
  it("sessions.json から sessionKey を解決して loadMessages できる", async () => {
    const tempDir = await mkdtemp(`${tmpdir()}/adjutant-transcript-`);
    const snapshot = snapshotEnv();
    try {
      const sessionsPath = join(tempDir, "sessions.json");
      const transcriptPath = join(tempDir, "session-1.jsonl");

      await writeFile(
        sessionsPath,
        JSON.stringify({
          main: {
            sessionId: "session-1",
            sessionFile: transcriptPath,
          },
        }),
        "utf8"
      );
      const lines = [
        JSON.stringify({ type: "session", id: "session-1" }),
        JSON.stringify({
          timestamp: "2026-02-15T10:00:00.000Z",
          id: "m-1",
          message: {
            role: "user",
            content: [{ type: "text", text: "こんにちは" }],
          },
        }),
        JSON.stringify({
          timestamp: "2026-02-15T10:00:01.000Z",
          id: "m-2",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "了解しました" }],
          },
        }),
        JSON.stringify({
          type: "compaction",
          timestamp: "2026-02-15T10:00:02.000Z",
        }),
      ];
      await writeFile(transcriptPath, `${lines.join("\n")}\n`, "utf8");

      process.env.ADJUTANT_SESSION_ENTRIES_PATH = sessionsPath;
      const messages = await loadMessages({ sessionKey: "main" });
      assert.equal(messages.length, 2);

      const first = messages[0] as { role?: string; runId?: string };
      assert.equal(first.role, "user");
      assert.equal(first.runId, undefined);
      const last = messages[1] as { role?: string };
      assert.equal(last.role, "assistant");
    } finally {
      restoreEnv(snapshot);
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("loadRecentSessionEvents は limit で末尾 N 件を返す", async () => {
    const tempDir = await mkdtemp(`${tmpdir()}/adjutant-transcript-`);
    const snapshot = snapshotEnv();
    try {
      const sessionsPath = join(tempDir, "sessions.json");
      const transcriptPath = join(tempDir, "session-2.jsonl");

      await writeFile(
        sessionsPath,
        JSON.stringify({
          main: { sessionId: "session-2", sessionFile: transcriptPath },
        }),
        "utf8"
      );
      const lines = [
        JSON.stringify({
          timestamp: "2026-02-15T10:00:00.000Z",
          id: "m-1",
          message: { role: "user", content: [{ type: "text", text: "a" }] },
        }),
        JSON.stringify({
          timestamp: "2026-02-15T10:00:01.000Z",
          id: "m-2",
          message: { role: "assistant", content: [{ type: "text", text: "b" }] },
        }),
        JSON.stringify({
          timestamp: "2026-02-15T10:00:02.000Z",
          id: "m-3",
          message: { role: "assistant", content: [{ type: "text", text: "c" }] },
        }),
      ];
      await writeFile(transcriptPath, `${lines.join("\n")}\n`, "utf8");

      process.env.ADJUTANT_SESSION_ENTRIES_PATH = sessionsPath;
      const events = await loadRecentSessionEvents({ sessionKey: "main", limit: 2 });
      assert.equal(events.length, 2);
      assert.deepEqual(
        events.map((event) => event.messageId),
        ["m-2", "m-3"]
      );
      assert.equal(events[0]?.role, "assistant");
    } finally {
      restoreEnv(snapshot);
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("custom_message(customType=adjutant:heartbeat) と直後の assistant 応答を除外し toolCount を付与する", async () => {
    const tempDir = await mkdtemp(`${tmpdir()}/adjutant-transcript-`);
    const snapshot = snapshotEnv();
    try {
      const sessionsPath = join(tempDir, "sessions.json");
      const transcriptPath = join(tempDir, "session-heartbeat-audit.jsonl");

      await writeFile(
        sessionsPath,
        JSON.stringify({
          main: { sessionId: "session-heartbeat-audit", sessionFile: transcriptPath },
        }),
        "utf8"
      );
      await writeFile(
        transcriptPath,
        [
          JSON.stringify({
            timestamp: "2026-02-23T10:00:00.000Z",
            message: {
              role: "user",
              runId: "run-user-1",
              content: [{ type: "text", text: "通常の質問" }],
            },
          }),
          JSON.stringify({
            timestamp: "2026-02-23T10:00:01.000Z",
            id: "msg-assistant-1",
            message: {
              role: "assistant",
              runId: "run-user-1",
              content: [{ type: "text", text: "通常の応答" }],
            },
          }),
          JSON.stringify({
            type: "custom",
            customType: "adjutant:run-summary",
            data: {
              runId: "run-user-1",
              assistantMessageId: "msg-assistant-1",
              toolCount: 2,
              tools: [
                { toolName: "bash", endedAt: "2026-02-23T10:00:00.500Z" },
                { toolName: "read_file", endedAt: "2026-02-23T10:00:00.800Z" },
              ],
            },
          }),
          JSON.stringify({
            timestamp: "2026-02-23T10:01:00.000Z",
            type: "custom_message",
            customType: "adjutant:heartbeat",
            content: "# HEARTBEAT\ncheck",
            display: false,
            details: {
              runId: "run-hb-1",
            },
          }),
          JSON.stringify({
            timestamp: "2026-02-23T10:01:01.000Z",
            message: {
              role: "assistant",
              runId: "run-hb-1",
              content: [{ type: "text", text: "heartbeat result" }],
            },
          }),
          JSON.stringify({
            timestamp: "2026-02-23T10:02:00.000Z",
            message: {
              role: "user",
              runId: "run-user-2",
              content: [{ type: "text", text: "後続メッセージ" }],
            },
          }),
        ].join("\n"),
        "utf8"
      );

      process.env.ADJUTANT_SESSION_ENTRIES_PATH = sessionsPath;
      delete process.env.ADJUTANT_AGENT_AUDIT_LOG_PATH;

      const messages = await loadMessages({ sessionKey: "main" });
      assert.equal(messages.length, 3);
      assert.equal(messages[0]?.role, "user");
      assert.equal(messages[1]?.role, "assistant");
      assert.equal(messages[2]?.role, "user");
      assert.equal(messages[1]?.runId, "run-user-1");
      assert.equal(messages[1]?.toolCount, 2);
    } finally {
      restoreEnv(snapshot);
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("run-context と run-summary から assistant の runId/toolCount を復元できる", async () => {
    const tempDir = await mkdtemp(`${tmpdir()}/adjutant-transcript-`);
    const snapshot = snapshotEnv();
    try {
      const sessionsPath = join(tempDir, "sessions.json");
      const transcriptPath = join(tempDir, "session-message-bind.jsonl");

      await writeFile(
        sessionsPath,
        JSON.stringify({
          main: { sessionId: "session-message-bind", sessionFile: transcriptPath },
        }),
        "utf8"
      );
      await writeFile(
        transcriptPath,
        [
          JSON.stringify({
            timestamp: "2026-02-23T11:00:00.000Z",
            id: "msg-user-1",
            message: {
              role: "user",
              content: [{ type: "text", text: "質問です" }],
            },
          }),
          JSON.stringify({
            type: "custom",
            customType: "adjutant:run-context",
            data: { runId: "run-user-1", origin: "user", sessionKey: "main" },
          }),
          JSON.stringify({
            timestamp: "2026-02-23T11:00:01.000Z",
            id: "msg-assistant-1",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "回答です" }],
            },
          }),
          JSON.stringify({
            type: "custom",
            customType: "adjutant:run-summary",
            data: {
              runId: "run-user-1",
              assistantMessageId: "msg-assistant-1",
              toolCount: 1,
              tools: [{ toolName: "read_file", endedAt: "2026-02-23T11:00:01.000Z" }],
            },
          }),
        ].join("\n"),
        "utf8"
      );

      process.env.ADJUTANT_SESSION_ENTRIES_PATH = sessionsPath;
      delete process.env.ADJUTANT_AGENT_AUDIT_LOG_PATH;

      const messages = await loadMessages({ sessionKey: "main" });
      assert.equal(messages.length, 2);
      assert.equal(messages[0]?.runId, undefined);
      assert.equal(messages[1]?.runId, "run-user-1");
      assert.equal(messages[1]?.toolCount, 1);
    } finally {
      restoreEnv(snapshot);
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("run-summary の assistantMessageId が不正な場合は toolCount を付与しない", async () => {
    const tempDir = await mkdtemp(`${tmpdir()}/adjutant-transcript-`);
    const snapshot = snapshotEnv();
    try {
      const sessionsPath = join(tempDir, "sessions.json");
      const transcriptPath = join(tempDir, "session-invalid-assistant-id.jsonl");

      await writeFile(
        sessionsPath,
        JSON.stringify({
          main: { sessionId: "session-invalid-assistant-id", sessionFile: transcriptPath },
        }),
        "utf8"
      );
      await writeFile(
        transcriptPath,
        [
          JSON.stringify({
            type: "custom",
            customType: "adjutant:run-context",
            data: { runId: "run-invalid", origin: "user", sessionKey: "main" },
          }),
          JSON.stringify({
            id: "msg-assistant-actual",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "応答" }],
            },
          }),
          JSON.stringify({
            type: "custom",
            customType: "adjutant:run-summary",
            data: {
              runId: "run-invalid",
              assistantMessageId: "msg-assistant-missing",
              toolCount: 2,
              tools: [
                { toolName: "bash", endedAt: "2026-02-23T12:10:00.100Z" },
                { toolName: "read_file", endedAt: "2026-02-23T12:10:00.200Z" },
              ],
            },
          }),
        ].join("\n"),
        "utf8"
      );

      process.env.ADJUTANT_SESSION_ENTRIES_PATH = sessionsPath;
      const messages = await loadMessages({ sessionKey: "main" });
      assert.equal(messages.length, 1);
      assert.equal(messages[0]?.runId, "run-invalid");
      assert.equal(messages[0]?.toolCount, undefined);
    } finally {
      restoreEnv(snapshot);
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("assistantMessageId 欠落時は runId + 直近 assistant フォールバックで toolCount を適用する", async () => {
    const tempDir = await mkdtemp(`${tmpdir()}/adjutant-transcript-`);
    const snapshot = snapshotEnv();
    try {
      const sessionsPath = join(tempDir, "sessions.json");
      const transcriptPath = join(tempDir, "session-summary-fallback.jsonl");

      await writeFile(
        sessionsPath,
        JSON.stringify({
          main: { sessionId: "session-summary-fallback", sessionFile: transcriptPath },
        }),
        "utf8"
      );
      await writeFile(
        transcriptPath,
        [
          JSON.stringify({
            timestamp: "2026-02-23T12:00:00.000Z",
            id: "msg-user-1",
            message: { role: "user", content: [{ type: "text", text: "質問1" }] },
          }),
          JSON.stringify({
            type: "custom",
            customType: "adjutant:run-context",
            data: { runId: "run-main-1", origin: "user", sessionKey: "main" },
          }),
          JSON.stringify({
            timestamp: "2026-02-23T12:00:03.000Z",
            id: "msg-assistant-1",
            message: { role: "assistant", content: [{ type: "text", text: "回答1" }] },
          }),
          JSON.stringify({
            type: "custom",
            customType: "adjutant:run-summary",
            data: {
              runId: "run-main-1",
              toolCount: 1,
              tools: [{ toolName: "read_file", endedAt: "2026-02-23T12:00:03.100Z" }],
            },
          }),
          JSON.stringify({
            timestamp: "2026-02-23T12:01:00.000Z",
            id: "msg-user-2",
            message: { role: "user", content: [{ type: "text", text: "質問2" }] },
          }),
          JSON.stringify({
            type: "custom",
            customType: "adjutant:run-context",
            data: { runId: "run-main-2", origin: "user", sessionKey: "main" },
          }),
          JSON.stringify({
            timestamp: "2026-02-23T12:01:04.000Z",
            id: "msg-assistant-2",
            message: { role: "assistant", content: [{ type: "text", text: "回答2" }] },
          }),
          JSON.stringify({
            type: "custom",
            customType: "adjutant:run-summary",
            data: {
              runId: "run-main-2",
              toolCount: 2,
              tools: [
                { toolName: "bash", endedAt: "2026-02-23T12:01:04.200Z" },
                { toolName: "read_file", endedAt: "2026-02-23T12:01:04.500Z" },
              ],
            },
          }),
        ].join("\n"),
        "utf8"
      );

      process.env.ADJUTANT_SESSION_ENTRIES_PATH = sessionsPath;
      delete process.env.ADJUTANT_AGENT_AUDIT_LOG_PATH;

      const messages = await loadMessages({ sessionKey: "main" });
      assert.equal(messages.length, 4);
      assert.equal(messages[0]?.runId, undefined);
      assert.equal(messages[1]?.runId, "run-main-1");
      assert.equal(messages[1]?.toolCount, 1);
      assert.equal(messages[3]?.runId, "run-main-2");
      assert.equal(messages[3]?.toolCount, 2);
    } finally {
      restoreEnv(snapshot);
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("audit ログがなくても custom_message heartbeat ターンを除外する", async () => {
    const tempDir = await mkdtemp(`${tmpdir()}/adjutant-transcript-`);
    const snapshot = snapshotEnv();
    try {
      const sessionsPath = join(tempDir, "sessions.json");
      const transcriptPath = join(tempDir, "session-heartbeat-fallback.jsonl");
      await writeFile(
        sessionsPath,
        JSON.stringify({
          main: { sessionId: "session-heartbeat-fallback", sessionFile: transcriptPath },
        }),
        "utf8"
      );
      await writeFile(
        transcriptPath,
        [
          JSON.stringify({
            timestamp: "2026-02-23T10:00:00.000Z",
            message: {
              role: "user",
              content: [{ type: "text", text: "普通の会話" }],
            },
          }),
          JSON.stringify({
            timestamp: "2026-02-23T10:00:01.000Z",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "了解" }],
            },
          }),
          JSON.stringify({
            timestamp: "2026-02-23T10:01:00.000Z",
            type: "custom_message",
            customType: "adjutant:heartbeat",
            content: "# HEARTBEAT\nscheduled run",
            display: false,
          }),
          JSON.stringify({
            timestamp: "2026-02-23T10:01:01.000Z",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "hb reply" }],
            },
          }),
          JSON.stringify({
            timestamp: "2026-02-23T10:02:00.000Z",
            message: {
              role: "user",
              content: [{ type: "text", text: "後続メッセージ" }],
            },
          }),
        ].join("\n"),
        "utf8"
      );

      process.env.ADJUTANT_SESSION_ENTRIES_PATH = sessionsPath;
      delete process.env.ADJUTANT_AGENT_AUDIT_LOG_PATH;

      const messages = await loadMessages({ sessionKey: "main" });
      assert.equal(messages.length, 3);
      assert.deepEqual(
        messages.map((message) => message.role),
        ["user", "assistant", "user"]
      );
      assert.deepEqual(messages[2]?.content, [{ type: "text", text: "後続メッセージ" }]);
    } finally {
      restoreEnv(snapshot);
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("破損行はスキップして警告を出す", async () => {
    const tempDir = await mkdtemp(`${tmpdir()}/adjutant-transcript-`);
    const snapshot = snapshotEnv();
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(" "));
    };

    try {
      const sessionsPath = join(tempDir, "sessions.json");
      const transcriptPath = join(tempDir, "session-3.jsonl");

      await writeFile(
        sessionsPath,
        JSON.stringify({
          main: { sessionId: "session-3", sessionFile: transcriptPath },
        }),
        "utf8"
      );
      await writeFile(
        transcriptPath,
        [
          JSON.stringify({
            timestamp: "2026-02-15T10:00:00.000Z",
            id: "m-1",
            message: { role: "user", content: [{ type: "text", text: "ok" }] },
          }),
          "{broken-json",
        ].join("\n"),
        "utf8"
      );

      process.env.ADJUTANT_SESSION_ENTRIES_PATH = sessionsPath;
      const messages = await loadMessages({ sessionKey: "main" });
      assert.equal(messages.length, 1);
      assert.equal(warnings.length >= 1, true);
      assert.equal(
        warnings.some((line) => line.includes("malformed transcript line")),
        true
      );
    } finally {
      console.warn = originalWarn;
      restoreEnv(snapshot);
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("共通パイプラインで malformed 行をスキップしつつ両APIを継続できる", async () => {
    const tempDir = await mkdtemp(`${tmpdir()}/adjutant-transcript-`);
    const snapshot = snapshotEnv();
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(" "));
    };

    try {
      const sessionsPath = join(tempDir, "sessions.json");
      const transcriptPath = join(tempDir, "session-common.jsonl");
      await writeFile(
        sessionsPath,
        JSON.stringify({
          main: { sessionId: "session-common", sessionFile: transcriptPath },
        }),
        "utf8"
      );
      await writeFile(
        transcriptPath,
        [
          JSON.stringify({
            timestamp: "2026-02-15T10:00:00.000Z",
            id: "m-1",
            message: { role: "user", content: [{ type: "text", text: "first" }] },
          }),
          "{broken-json",
          JSON.stringify({
            timestamp: "2026-02-15T10:00:01.000Z",
            id: "m-2",
            message: { role: "assistant", content: [{ type: "text", text: "second" }] },
          }),
        ].join("\n"),
        "utf8"
      );

      process.env.ADJUTANT_SESSION_ENTRIES_PATH = sessionsPath;
      const messages = await loadMessages({ sessionKey: "main" });
      const recent = await loadRecentSessionEvents({ sessionKey: "main", limit: 5 });

      assert.equal(messages.length, 2);
      assert.equal(recent.length, 2);
      assert.deepEqual(
        recent.map((event) => event.messageId),
        ["m-1", "m-2"]
      );
      assert.equal(
        warnings.some((line) => line.includes("malformed transcript line")),
        true
      );
    } finally {
      console.warn = originalWarn;
      restoreEnv(snapshot);
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("未知 sessionKey では空配列を返す", async () => {
    const tempDir = await mkdtemp(`${tmpdir()}/adjutant-transcript-`);
    const snapshot = snapshotEnv();
    try {
      const sessionsPath = join(tempDir, "sessions.json");
      await writeFile(sessionsPath, JSON.stringify({ main: { sessionId: "s1" } }), "utf8");
      process.env.ADJUTANT_SESSION_ENTRIES_PATH = sessionsPath;

      const messages = await loadMessages({ sessionKey: "unknown" });
      const events = await loadRecentSessionEvents({ sessionKey: "unknown", limit: 5 });
      assert.deepEqual(messages, []);
      assert.deepEqual(events, []);
    } finally {
      restoreEnv(snapshot);
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("sessionFile 未指定時は sessions.json と同じディレクトリから探す", async () => {
    const tempDir = await mkdtemp(`${tmpdir()}/adjutant-transcript-`);
    const snapshot = snapshotEnv();
    try {
      const sessionsPath = join(tempDir, "sessions.json");
      const transcriptPath = join(tempDir, "session-4.jsonl");
      await mkdir(tempDir, { recursive: true });

      await writeFile(
        sessionsPath,
        JSON.stringify({
          main: { sessionId: "session-4" },
        }),
        "utf8"
      );
      await writeFile(
        transcriptPath,
        `${JSON.stringify({
          timestamp: "2026-02-15T10:00:00.000Z",
          id: "m-1",
          message: { role: "assistant", content: [{ type: "text", text: "fallback" }] },
        })}\n`,
        "utf8"
      );

      process.env.ADJUTANT_SESSION_ENTRIES_PATH = sessionsPath;
      delete process.env.ADJUTANT_TRANSCRIPTS_DIR;

      const messages = await loadMessages({ sessionKey: "main" });
      assert.equal(messages.length, 1);
    } finally {
      restoreEnv(snapshot);
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("sessionFile が相対パスでも sessions.json 基準で解決できる", async () => {
    const tempDir = await mkdtemp(`${tmpdir()}/adjutant-transcript-`);
    const snapshot = snapshotEnv();
    try {
      const sessionsPath = join(tempDir, "sessions.json");
      const transcriptDir = join(tempDir, "transcripts");
      const transcriptPath = join(transcriptDir, "custom.jsonl");
      await mkdir(transcriptDir, { recursive: true });

      await writeFile(
        sessionsPath,
        JSON.stringify({
          main: { sessionId: "session-5", sessionFile: "transcripts/custom.jsonl" },
        }),
        "utf8"
      );
      await writeFile(
        transcriptPath,
        `${JSON.stringify({
          timestamp: "2026-02-15T10:00:00.000Z",
          id: "m-1",
          message: { role: "assistant", content: [{ type: "text", text: "relative-path" }] },
        })}\n`,
        "utf8"
      );

      process.env.ADJUTANT_SESSION_ENTRIES_PATH = sessionsPath;
      const messages = await loadMessages({ sessionKey: "main" });
      assert.equal(messages.length, 1);
    } finally {
      restoreEnv(snapshot);
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("loadRecentSessionEvents は limit が非数なら空配列を返す", async () => {
    const tempDir = await mkdtemp(`${tmpdir()}/adjutant-transcript-`);
    const snapshot = snapshotEnv();
    try {
      const sessionsPath = join(tempDir, "sessions.json");
      const transcriptPath = join(tempDir, "session-6.jsonl");
      await writeFile(
        sessionsPath,
        JSON.stringify({
          main: { sessionId: "session-6", sessionFile: transcriptPath },
        }),
        "utf8"
      );
      await writeFile(
        transcriptPath,
        `${JSON.stringify({
          timestamp: "2026-02-15T10:00:00.000Z",
          id: "m-1",
          message: { role: "assistant", content: [{ type: "text", text: "x" }] },
        })}\n`,
        "utf8"
      );

      process.env.ADJUTANT_SESSION_ENTRIES_PATH = sessionsPath;
      const events = await loadRecentSessionEvents({ sessionKey: "main", limit: Number.NaN });
      assert.deepEqual(events, []);
    } finally {
      restoreEnv(snapshot);
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
