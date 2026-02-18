import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getLastHeartbeatEvent,
  onHeartbeatEvent,
  resetHeartbeatRunnerForTest,
  runOnce,
  setHeartbeatRuntimeForTest,
  startHeartbeat,
  stripHeartbeatToken,
} from "../../src/assistant/heartbeat-runner.js";

async function preparePromptFiles(baseDir: string, heartbeatContent: string): Promise<void> {
  const promptsDir = join(baseDir, "assistant", "prompts");
  await mkdir(promptsDir, { recursive: true });
  await writeFile(join(promptsDir, "HEARTBEAT.md"), heartbeatContent, "utf8");
  await writeFile(join(promptsDir, "SOUL.md"), "You are Adjutant.", "utf8");
  await writeFile(join(promptsDir, "USER.md"), "User preference.", "utf8");
  await writeFile(join(promptsDir, "AGENTS.md"), "Agent guideline.", "utf8");
}

function createBaseConfig(tempDir: string) {
  return {
    dataDir: tempDir,
    workspaceDir: tempDir,
    sessionEntriesPath: join(tempDir, "sessions.json"),
    heartbeatFilePath: join(tempDir, "assistant", "prompts", "HEARTBEAT.md"),
    soulFilePath: join(tempDir, "assistant", "prompts", "SOUL.md"),
    userFilePath: join(tempDir, "assistant", "prompts", "USER.md"),
    agentsFilePath: join(tempDir, "assistant", "prompts", "AGENTS.md"),
    intervalMs: 20,
    ackMaxChars: 5,
    retryDelayMs: 5,
  };
}

describe("HeartbeatRunner", () => {
  afterEach(() => {
    resetHeartbeatRunnerForTest();
  });

  it("startHeartbeat は intervalMs 後に heartbeat タスクを実行する", async () => {
    const tempDir = await mkdtemp(`${tmpdir()}/adjutant-heartbeat-`);
    try {
      await preparePromptFiles(tempDir, "Heartbeat prompt");
      let runCount = 0;

      setHeartbeatRuntimeForTest({
        readEvents: async () => [],
        readMemoryFiles: async () => ({
          longTerm: null,
          daily: null,
          yesterday: null,
        }),
        buildEventContext: () => ({ text: "", truncated: false, eventCount: 0 }),
        getQueueSize: () => 0,
        runAgent: async () => {
          runCount += 1;
          return {
            status: "completed",
            durationMs: 1,
            text: "ALERT: this should be delivered",
          };
        },
      });

      const handle = startHeartbeat(createBaseConfig(tempDir));
      await new Promise((resolve) => setTimeout(resolve, 80));
      handle.stop();
      await new Promise((resolve) => setTimeout(resolve, 30));

      assert.equal(runCount > 0, true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("runOnce は単発実行し、triggerReason を HeartbeatRunRecord に記録する", async () => {
    const tempDir = await mkdtemp(`${tmpdir()}/adjutant-heartbeat-`);
    try {
      await preparePromptFiles(tempDir, "Heartbeat prompt");

      setHeartbeatRuntimeForTest({
        readEvents: async () => [],
        readMemoryFiles: async () => ({
          longTerm: null,
          daily: null,
          yesterday: null,
        }),
        buildEventContext: () => ({ text: "", truncated: false, eventCount: 0 }),
        getQueueSize: () => 0,
        runAgent: async () => ({
          status: "completed",
          durationMs: 10,
          text: "ALERT: investigate #incident immediately",
          modelId: "gpt-4o-mini",
        }),
      });

      const result = await runOnce(createBaseConfig(tempDir), { reason: "manual-run" });
      assert.equal(result.status, "ran");
      if (result.status === "ran") {
        assert.equal(result.alert?.includes("investigate"), true);
      }

      const recordPath = join(tempDir, "_assistant", "heartbeat-runs.jsonl");
      const raw = await readFile(recordPath, "utf8");
      const lines = raw.trim().split(/\r?\n/);
      const latest = JSON.parse(lines[lines.length - 1] ?? "{}") as {
        triggerReason?: string;
      };
      assert.equal(latest.triggerReason, "manual-run");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("onHeartbeatEvent は購読/解除できる", async () => {
    const tempDir = await mkdtemp(`${tmpdir()}/adjutant-heartbeat-`);
    try {
      await preparePromptFiles(tempDir, "Heartbeat prompt");
      const events: string[] = [];
      const unsubscribe = onHeartbeatEvent((evt) => events.push(evt.status));

      setHeartbeatRuntimeForTest({
        readEvents: async () => [],
        readMemoryFiles: async () => ({
          longTerm: null,
          daily: null,
          yesterday: null,
        }),
        buildEventContext: () => ({ text: "", truncated: false, eventCount: 0 }),
        getQueueSize: () => 0,
        runAgent: async () => ({
          status: "completed",
          durationMs: 1,
          text: "ALERT: notify now",
        }),
      });

      await runOnce(createBaseConfig(tempDir), { reason: "first" });
      unsubscribe();
      await runOnce(createBaseConfig(tempDir), { reason: "second" });

      assert.equal(events.length, 1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("getLastHeartbeatEvent は直近 payload を返し、未実行時は null", async () => {
    assert.equal(getLastHeartbeatEvent(), null);

    const tempDir = await mkdtemp(`${tmpdir()}/adjutant-heartbeat-`);
    try {
      await preparePromptFiles(tempDir, "Heartbeat prompt");
      setHeartbeatRuntimeForTest({
        readEvents: async () => [],
        readMemoryFiles: async () => ({
          longTerm: null,
          daily: null,
          yesterday: null,
        }),
        buildEventContext: () => ({ text: "", truncated: false, eventCount: 0 }),
        getQueueSize: () => 0,
        runAgent: async () => ({
          status: "completed",
          durationMs: 1,
          text: "ALERT: notify now",
        }),
      });

      await runOnce(createBaseConfig(tempDir), { reason: "manual" });
      const latest = getLastHeartbeatEvent();
      assert.notEqual(latest, null);
      assert.equal(latest?.status, "sent");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("assistant/prompts/HEARTBEAT.md が実質空なら skipped(empty-heartbeat-file)", async () => {
    const tempDir = await mkdtemp(`${tmpdir()}/adjutant-heartbeat-`);
    try {
      await preparePromptFiles(tempDir, "\n   \n<!-- comment -->\n");
      let runAgentCalled = false;

      setHeartbeatRuntimeForTest({
        readEvents: async () => [],
        readMemoryFiles: async () => ({
          longTerm: null,
          daily: null,
          yesterday: null,
        }),
        buildEventContext: () => ({ text: "", truncated: false, eventCount: 0 }),
        getQueueSize: () => 0,
        runAgent: async () => {
          runAgentCalled = true;
          return { status: "completed", durationMs: 1, text: "unexpected" };
        },
      });

      const result = await runOnce(createBaseConfig(tempDir), { reason: "manual" });
      assert.deepEqual(result, {
        status: "skipped",
        reason: "empty-heartbeat-file",
      });
      assert.equal(runAgentCalled, false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("stripHeartbeatToken は HTML/Markdown/HEARTBEAT_OK を除去して判定する", () => {
    const stripped = stripHeartbeatToken(
      "<b>HEARTBEAT_OK</b> **確認済み** &nbsp; [link](https://example.com)",
      3
    );
    assert.equal(stripped.hasOkToken, true);
    assert.equal(stripped.normalizedText.includes("HEARTBEAT_OK"), false);
    assert.equal(stripped.normalizedText.includes("link"), true);
    assert.equal(stripped.shouldSkip, true);
  });

  it("HEARTBEAT_OK 応答は ok-token として抑制される", async () => {
    const tempDir = await mkdtemp(`${tmpdir()}/adjutant-heartbeat-`);
    try {
      await preparePromptFiles(tempDir, "Heartbeat prompt");
      setHeartbeatRuntimeForTest({
        readEvents: async () => [],
        readMemoryFiles: async () => ({
          longTerm: null,
          daily: null,
          yesterday: null,
        }),
        buildEventContext: () => ({ text: "", truncated: false, eventCount: 0 }),
        getQueueSize: () => 0,
        runAgent: async () => ({
          status: "completed",
          durationMs: 1,
          text: "<div>HEARTBEAT_OK</div>",
          modelId: "gpt-4o-mini",
        }),
      });

      const result = await runOnce(createBaseConfig(tempDir), { reason: "timer" });
      assert.equal(result.status, "ran");
      const payload = getLastHeartbeatEvent();
      assert.equal(payload?.status, "ok-token");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("注目イベント応答はアラートとして送信イベントになる", async () => {
    const tempDir = await mkdtemp(`${tmpdir()}/adjutant-heartbeat-`);
    try {
      await preparePromptFiles(tempDir, "Heartbeat prompt");
      setHeartbeatRuntimeForTest({
        readEvents: async () => [],
        readMemoryFiles: async () => ({
          longTerm: null,
          daily: null,
          yesterday: null,
        }),
        buildEventContext: () => ({ text: "", truncated: false, eventCount: 0 }),
        getQueueSize: () => 0,
        runAgent: async () => ({
          status: "completed",
          durationMs: 1,
          text: "ALERT: #incident に障害報告がありました。詳細を確認してください。",
          modelId: "gpt-4o-mini",
        }),
      });

      const result = await runOnce(
        {
          ...createBaseConfig(tempDir),
          ackMaxChars: 1,
        },
        { reason: "timer" }
      );
      assert.equal(result.status, "ran");
      if (result.status === "ran") {
        assert.equal(result.alert?.includes("#incident"), true);
      }
      const payload = getLastHeartbeatEvent();
      assert.equal(payload?.status, "sent");
      assert.equal(payload?.indicatorType, "alert");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("SOUL.md の内容を systemPrompt に反映する", async () => {
    const tempDir = await mkdtemp(`${tmpdir()}/adjutant-heartbeat-`);
    try {
      await preparePromptFiles(tempDir, "Heartbeat prompt");
      await writeFile(
        join(tempDir, "assistant", "prompts", "SOUL.md"),
        "SOUL_DIRECTIVE: prioritize concise summaries",
        "utf8"
      );
      let capturedSystemPrompt = "";

      setHeartbeatRuntimeForTest({
        readEvents: async () => [],
        readMemoryFiles: async () => ({
          longTerm: null,
          daily: null,
          yesterday: null,
        }),
        buildEventContext: () => ({ text: "", truncated: false, eventCount: 0 }),
        getQueueSize: () => 0,
        runAgent: async (opts) => {
          capturedSystemPrompt = opts.systemPrompt ?? "";
          return {
            status: "completed",
            durationMs: 1,
            text: "HEARTBEAT_OK",
          };
        },
      });

      await runOnce(createBaseConfig(tempDir), { reason: "manual" });
      assert.equal(capturedSystemPrompt.includes("SOUL_DIRECTIVE"), true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("quiet-hours は skipped(quiet-hours) になる", async () => {
    const tempDir = await mkdtemp(`${tmpdir()}/adjutant-heartbeat-`);
    try {
      await preparePromptFiles(tempDir, "Heartbeat prompt");
      setHeartbeatRuntimeForTest({
        now: () => new Date("2026-02-15T00:30:00.000Z"),
      });

      const result = await runOnce({
        ...createBaseConfig(tempDir),
        userTimezone: "UTC",
        activeHours: {
          start: "09:00",
          end: "18:00",
          timezone: "user",
        },
      });
      assert.deepEqual(result, { status: "skipped", reason: "quiet-hours" });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("activeHours 深夜跨ぎ（start > end）を判定できる", async () => {
    const tempDir = await mkdtemp(`${tmpdir()}/adjutant-heartbeat-`);
    try {
      await preparePromptFiles(tempDir, "Heartbeat prompt");
      setHeartbeatRuntimeForTest({
        now: () => new Date("2026-02-15T23:30:00.000Z"),
        readEvents: async () => [],
        readMemoryFiles: async () => ({
          longTerm: null,
          daily: null,
          yesterday: null,
        }),
        buildEventContext: () => ({ text: "", truncated: false, eventCount: 0 }),
        getQueueSize: () => 0,
        runAgent: async () => ({
          status: "completed",
          durationMs: 1,
          text: "ALERT: night window",
        }),
      });

      const result = await runOnce({
        ...createBaseConfig(tempDir),
        userTimezone: "UTC",
        activeHours: {
          start: "22:00",
          end: "06:00",
          timezone: "user",
        },
      });

      assert.equal(result.status, "ran");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("requests-in-flight は skipped(requests-in-flight)", async () => {
    const tempDir = await mkdtemp(`${tmpdir()}/adjutant-heartbeat-`);
    try {
      await preparePromptFiles(tempDir, "Heartbeat prompt");
      let modelCalled = false;
      setHeartbeatRuntimeForTest({
        getQueueSize: () => 2,
        runAgent: async () => {
          modelCalled = true;
          return { status: "completed", durationMs: 1, text: "ALERT" };
        },
      });

      const result = await runOnce(createBaseConfig(tempDir));
      assert.deepEqual(result, { status: "skipped", reason: "requests-in-flight" });
      assert.equal(modelCalled, false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("precheck で skipped した場合も run record を残す", async () => {
    const tempDir = await mkdtemp(`${tmpdir()}/adjutant-heartbeat-`);
    try {
      await preparePromptFiles(tempDir, "Heartbeat prompt");
      setHeartbeatRuntimeForTest({
        getQueueSize: () => 1,
      });

      const result = await runOnce(createBaseConfig(tempDir), { reason: "timer" });
      assert.deepEqual(result, { status: "skipped", reason: "requests-in-flight" });

      const recordPath = join(tempDir, "_assistant", "heartbeat-runs.jsonl");
      const raw = await readFile(recordPath, "utf8");
      const lines = raw.trim().split(/\r?\n/);
      const latest = JSON.parse(lines[lines.length - 1] ?? "{}") as {
        triggerReason?: string;
        result?: { status?: string; reason?: string };
      };
      assert.equal(latest.triggerReason, "timer");
      assert.equal(latest.result?.status, "skipped");
      assert.equal(latest.result?.reason, "requests-in-flight");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("requests-in-flight 短周期再試行で次回実行される", async () => {
    const tempDir = await mkdtemp(`${tmpdir()}/adjutant-heartbeat-`);
    try {
      await preparePromptFiles(tempDir, "Heartbeat prompt");
      let queueCalls = 0;
      let runCalls = 0;

      setHeartbeatRuntimeForTest({
        getQueueSize: () => {
          queueCalls += 1;
          return queueCalls === 1 ? 1 : 0;
        },
        readEvents: async () => [],
        readMemoryFiles: async () => ({
          longTerm: null,
          daily: null,
          yesterday: null,
        }),
        buildEventContext: () => ({ text: "", truncated: false, eventCount: 0 }),
        runAgent: async () => {
          runCalls += 1;
          return { status: "completed", durationMs: 1, text: "ALERT: retry success" };
        },
      });

      const handle = startHeartbeat({
        ...createBaseConfig(tempDir),
        intervalMs: 20,
        retryDelayMs: 5,
      });
      await new Promise((resolve) => setTimeout(resolve, 80));
      handle.stop();
      await new Promise((resolve) => setTimeout(resolve, 150));

      assert.equal(runCalls >= 1, true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("timeline 逆走査で stale user post が無ければ skipped(no-stale-post)", async () => {
    const tempDir = await mkdtemp(`${tmpdir()}/adjutant-heartbeat-`);
    try {
      await preparePromptFiles(tempDir, "Heartbeat prompt");
      const timelineDir = join(tempDir, "memory");
      await mkdir(timelineDir, { recursive: true });
      await writeFile(
        join(timelineDir, "timeline.jsonl"),
        [
          JSON.stringify({
            recordType: "event",
            role: "user",
            kind: "post",
            uid: "uid-old-before-boundary",
            ts: 0,
          }),
          JSON.stringify({ recordType: "action", role: "system", uid: "boundary-1", ts: 1_000 }),
          JSON.stringify({
            recordType: "event",
            role: "user",
            kind: "post",
            uid: "uid-fresh-after-boundary",
            ts: 9_800,
          }),
        ].join("\n"),
        "utf8"
      );

      let runAgentCalled = false;
      setHeartbeatRuntimeForTest({
        now: () => new Date(10_000),
        getQueueSize: () => 0,
        runAgent: async () => {
          runAgentCalled = true;
          return { text: "ALERT: unexpected" };
        },
      });

      const result = await runOnce({
        ...createBaseConfig(tempDir),
        heartbeatStaleMs: 1_000,
      });
      assert.deepEqual(result, { status: "skipped", reason: "no-stale-post" });
      assert.equal(runAgentCalled, false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("timeline 逆走査で stale post が pending backfill 中なら skipped(pending-session-backfill)", async () => {
    const tempDir = await mkdtemp(`${tmpdir()}/adjutant-heartbeat-`);
    try {
      await preparePromptFiles(tempDir, "Heartbeat prompt");
      const timelineDir = join(tempDir, "memory");
      await mkdir(timelineDir, { recursive: true });
      await writeFile(
        join(timelineDir, "timeline.jsonl"),
        JSON.stringify({
          recordType: "event",
          role: "user",
          kind: "post",
          uid: "uid-pending",
          ts: 0,
        }),
        "utf8"
      );

      let runAgentCalled = false;
      setHeartbeatRuntimeForTest({
        now: () => new Date(10_000),
        getQueueSize: () => 0,
        runAgent: async () => {
          runAgentCalled = true;
          return { text: "ALERT: unexpected" };
        },
      });

      const result = await runOnce({
        ...createBaseConfig(tempDir),
        heartbeatStaleMs: 1_000,
        pendingSessionBackfillProvider: () => ["uid-pending"],
      });
      assert.deepEqual(result, { status: "skipped", reason: "pending-session-backfill" });
      assert.equal(runAgentCalled, false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("timeline 逆走査で stale user post があれば heartbeat を実行する", async () => {
    const tempDir = await mkdtemp(`${tmpdir()}/adjutant-heartbeat-`);
    try {
      await preparePromptFiles(tempDir, "Heartbeat prompt");
      const timelineDir = join(tempDir, "memory");
      await mkdir(timelineDir, { recursive: true });
      await writeFile(
        join(timelineDir, "timeline.jsonl"),
        JSON.stringify({
          recordType: "event",
          role: "user",
          kind: "post",
          uid: "uid-stale",
          ts: 0,
        }),
        "utf8"
      );

      let runAgentCalled = false;
      setHeartbeatRuntimeForTest({
        now: () => new Date(10_000),
        readEvents: async () => [],
        readMemoryFiles: async () => ({
          longTerm: null,
          daily: null,
          yesterday: null,
        }),
        buildEventContext: () => ({ text: "", truncated: false, eventCount: 0 }),
        getQueueSize: () => 0,
        runAgent: async () => {
          runAgentCalled = true;
          return { text: "HEARTBEAT_OK", modelId: "gpt-4o-mini" };
        },
      });

      const result = await runOnce({
        ...createBaseConfig(tempDir),
        heartbeatStaleMs: 1_000,
      });
      assert.equal(result.status, "ran");
      assert.equal(runAgentCalled, true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("timeline 逆走査失敗は skipped(timeline-scan-failed) になり次回周期で再評価できる", async () => {
    const tempDir = await mkdtemp(`${tmpdir()}/adjutant-heartbeat-`);
    try {
      await preparePromptFiles(tempDir, "Heartbeat prompt");
      let scanCount = 0;
      let runAgentCalled = 0;

      setHeartbeatRuntimeForTest({
        now: () => new Date(10_000),
        getQueueSize: () => 0,
        scanHeartbeatTimeline: async () => {
          scanCount += 1;
          if (scanCount === 1) {
            throw new Error("timeline scan crashed");
          }
          return {
            shouldRun: true,
            reason: "stale-post-found",
            stalePostUids: ["uid-stale"],
            blockedPendingUids: [],
            boundaryFound: false,
            inspectedRecords: 1,
          };
        },
        readEvents: async () => [],
        readMemoryFiles: async () => ({
          longTerm: null,
          daily: null,
          yesterday: null,
        }),
        buildEventContext: () => ({ text: "", truncated: false, eventCount: 0 }),
        runAgent: async () => {
          runAgentCalled += 1;
          return { text: "HEARTBEAT_OK", modelId: "gpt-4o-mini" };
        },
      });

      const first = await runOnce({
        ...createBaseConfig(tempDir),
        heartbeatStaleMs: 1_000,
      });
      assert.deepEqual(first, { status: "skipped", reason: "timeline-scan-failed" });

      const second = await runOnce({
        ...createBaseConfig(tempDir),
        heartbeatStaleMs: 1_000,
      });
      assert.equal(second.status, "ran");
      assert.equal(runAgentCalled, 1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("readiness 失敗（alert path）は skipped(readiness-failed)", async () => {
    const tempDir = await mkdtemp(`${tmpdir()}/adjutant-heartbeat-`);
    try {
      await preparePromptFiles(tempDir, "Heartbeat prompt");
      setHeartbeatRuntimeForTest({
        readEvents: async () => [],
        readMemoryFiles: async () => ({
          longTerm: null,
          daily: null,
          yesterday: null,
        }),
        buildEventContext: () => ({ text: "", truncated: false, eventCount: 0 }),
        getQueueSize: () => 0,
        runAgent: async () => ({ status: "completed", durationMs: 1, text: "ALERT: notify" }),
      });

      const result = await runOnce({
        ...createBaseConfig(tempDir),
        readinessCheck: () => false,
      });

      assert.deepEqual(result, { status: "skipped", reason: "readiness-failed" });
      const evt = getLastHeartbeatEvent();
      assert.equal(evt?.status, "skipped");
      assert.equal(evt?.reason, "readiness-failed");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("readiness 失敗（ok path）は ran + ok-* を維持する", async () => {
    const tempDir = await mkdtemp(`${tmpdir()}/adjutant-heartbeat-`);
    try {
      await preparePromptFiles(tempDir, "Heartbeat prompt");
      setHeartbeatRuntimeForTest({
        readEvents: async () => [],
        readMemoryFiles: async () => ({
          longTerm: null,
          daily: null,
          yesterday: null,
        }),
        buildEventContext: () => ({ text: "", truncated: false, eventCount: 0 }),
        getQueueSize: () => 0,
        runAgent: async () => ({ status: "completed", durationMs: 1, text: "HEARTBEAT_OK" }),
      });

      const result = await runOnce({
        ...createBaseConfig(tempDir),
        readinessCheck: () => false,
      });

      assert.equal(result.status, "ran");
      const evt = getLastHeartbeatEvent();
      assert.equal(evt?.status, "ok-token");
      assert.equal(evt?.reason, "readiness-failed");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("heartbeat.session が無効/他 agent 指定なら main へフォールバックする", async () => {
    const tempDir = await mkdtemp(`${tmpdir()}/adjutant-heartbeat-`);
    try {
      await preparePromptFiles(tempDir, "Heartbeat prompt");
      const sessionsPath = join(tempDir, "sessions.json");
      await writeFile(
        sessionsPath,
        JSON.stringify({
          "session:other": { sessionId: "x", agent: "other-agent" },
          main: { sessionId: "main-session", agent: "adjutant" },
        }),
        "utf8"
      );

      let usedSessionKey = "";
      setHeartbeatRuntimeForTest({
        readEvents: async () => [],
        readMemoryFiles: async () => ({
          longTerm: null,
          daily: null,
          yesterday: null,
        }),
        buildEventContext: () => ({ text: "", truncated: false, eventCount: 0 }),
        getQueueSize: () => 0,
        runAgent: async (opts) => {
          usedSessionKey = opts.sessionKey ?? "";
          return { status: "completed", durationMs: 1, text: "ALERT" };
        },
      });

      await runOnce({
        ...createBaseConfig(tempDir),
        sessionEntriesPath: sessionsPath,
        sessionKey: "session:other",
      });

      assert.equal(usedSessionKey, "main");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("channels visibility が全 false なら alerts-disabled でスキップ", async () => {
    const tempDir = await mkdtemp(`${tmpdir()}/adjutant-heartbeat-`);
    try {
      await preparePromptFiles(tempDir, "Heartbeat prompt");
      let modelCalled = false;

      setHeartbeatRuntimeForTest({
        runAgent: async () => {
          modelCalled = true;
          return { status: "completed", durationMs: 1, text: "ALERT" };
        },
      });

      const result = await runOnce({
        ...createBaseConfig(tempDir),
        channelsVisibility: {
          showOk: false,
          showAlerts: false,
          useIndicator: false,
        },
      });

      assert.deepEqual(result, { status: "skipped", reason: "alerts-disabled" });
      assert.equal(modelCalled, false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("24h 以内同一アラートは duplicate で抑制し ran を維持", async () => {
    const tempDir = await mkdtemp(`${tmpdir()}/adjutant-heartbeat-`);
    try {
      await preparePromptFiles(tempDir, "Heartbeat prompt");
      const sessionsPath = join(tempDir, "sessions.json");
      await writeFile(
        sessionsPath,
        JSON.stringify({
          main: {
            sessionId: "main-session",
            agent: "adjutant",
            lastHeartbeatText: "ALERT: duplicate content",
            lastHeartbeatSentAt: "2026-02-15T00:00:00.000Z",
          },
        }),
        "utf8"
      );

      setHeartbeatRuntimeForTest({
        now: () => new Date("2026-02-15T10:00:00.000Z"),
        readEvents: async () => [],
        readMemoryFiles: async () => ({
          longTerm: null,
          daily: null,
          yesterday: null,
        }),
        buildEventContext: () => ({ text: "", truncated: false, eventCount: 0 }),
        getQueueSize: () => 0,
        runAgent: async () => ({
          status: "completed",
          durationMs: 1,
          text: "ALERT: duplicate content",
        }),
      });

      const result = await runOnce({
        ...createBaseConfig(tempDir),
        sessionEntriesPath: sessionsPath,
      });
      assert.equal(result.status, "ran");
      const evt = getLastHeartbeatEvent();
      assert.equal(evt?.status, "skipped");
      assert.equal(evt?.reason, "duplicate");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("重複ウィンドウ期限切れ後は再通知される", async () => {
    const tempDir = await mkdtemp(`${tmpdir()}/adjutant-heartbeat-`);
    try {
      await preparePromptFiles(tempDir, "Heartbeat prompt");
      const sessionsPath = join(tempDir, "sessions.json");
      await writeFile(
        sessionsPath,
        JSON.stringify({
          main: {
            sessionId: "main-session",
            agent: "adjutant",
            lastHeartbeatText: "ALERT: old content",
            lastHeartbeatSentAt: "2026-02-10T00:00:00.000Z",
          },
        }),
        "utf8"
      );

      setHeartbeatRuntimeForTest({
        now: () => new Date("2026-02-15T10:00:00.000Z"),
        readEvents: async () => [],
        readMemoryFiles: async () => ({
          longTerm: null,
          daily: null,
          yesterday: null,
        }),
        buildEventContext: () => ({ text: "", truncated: false, eventCount: 0 }),
        getQueueSize: () => 0,
        runAgent: async () => ({
          status: "completed",
          durationMs: 1,
          text: "ALERT: old content",
        }),
      });

      const result = await runOnce({
        ...createBaseConfig(tempDir),
        sessionEntriesPath: sessionsPath,
      });
      assert.equal(result.status, "ran");
      const evt = getLastHeartbeatEvent();
      assert.equal(evt?.status, "sent");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("lastHeartbeatText / lastHeartbeatSentAt が sessions.json に永続化される", async () => {
    const tempDir = await mkdtemp(`${tmpdir()}/adjutant-heartbeat-`);
    try {
      await preparePromptFiles(tempDir, "Heartbeat prompt");
      const sessionsPath = join(tempDir, "sessions.json");
      await writeFile(
        sessionsPath,
        JSON.stringify({ main: { sessionId: "main-session" } }),
        "utf8"
      );

      setHeartbeatRuntimeForTest({
        now: () => new Date("2026-02-15T10:00:00.000Z"),
        readEvents: async () => [],
        readMemoryFiles: async () => ({
          longTerm: null,
          daily: null,
          yesterday: null,
        }),
        buildEventContext: () => ({ text: "", truncated: false, eventCount: 0 }),
        getQueueSize: () => 0,
        runAgent: async () => ({
          status: "completed",
          durationMs: 1,
          text: "ALERT: persistent content",
        }),
      });

      await runOnce({ ...createBaseConfig(tempDir), sessionEntriesPath: sessionsPath });
      resetHeartbeatRunnerForTest();

      const saved = JSON.parse(await readFile(sessionsPath, "utf8")) as {
        main?: { lastHeartbeatText?: string; lastHeartbeatSentAt?: string };
      };
      assert.equal(saved.main?.lastHeartbeatText, "ALERT: persistent content");
      assert.equal(typeof saved.main?.lastHeartbeatSentAt, "string");

      setHeartbeatRuntimeForTest({
        now: () => new Date("2026-02-15T11:00:00.000Z"),
        readEvents: async () => [],
        readMemoryFiles: async () => ({
          longTerm: null,
          daily: null,
          yesterday: null,
        }),
        buildEventContext: () => ({ text: "", truncated: false, eventCount: 0 }),
        getQueueSize: () => 0,
        runAgent: async () => ({
          status: "completed",
          durationMs: 1,
          text: "ALERT: persistent content",
        }),
      });

      const result = await runOnce({
        ...createBaseConfig(tempDir),
        sessionEntriesPath: sessionsPath,
      });
      assert.equal(result.status, "ran");
      const evt = getLastHeartbeatEvent();
      assert.equal(evt?.reason, "duplicate");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("Current time 行を末尾に注入し、既存行があれば重複挿入しない", async () => {
    const tempDir = await mkdtemp(`${tmpdir()}/adjutant-heartbeat-`);
    try {
      await preparePromptFiles(tempDir, "Heartbeat prompt");
      const prompts: string[] = [];

      setHeartbeatRuntimeForTest({
        now: () => new Date("2026-02-15T10:00:00.000Z"),
        readEvents: async () => [],
        readMemoryFiles: async () => ({
          longTerm: null,
          daily: null,
          yesterday: null,
        }),
        buildEventContext: () => ({ text: "context", truncated: false, eventCount: 0 }),
        getQueueSize: () => 0,
        runAgent: async (opts) => {
          prompts.push(opts.prompt);
          return { status: "completed", durationMs: 1, text: "HEARTBEAT_OK" };
        },
      });

      await runOnce({ ...createBaseConfig(tempDir), userTimezone: "UTC" });
      assert.equal(prompts[0]?.includes("Current time:"), true);

      await preparePromptFiles(tempDir, "Heartbeat prompt\n\nCurrent time: 2026-02-15 10:00 (UTC)");
      await runOnce({ ...createBaseConfig(tempDir), userTimezone: "UTC" });

      const secondPrompt = prompts[1] ?? "";
      const currentTimeMatches = secondPrompt.match(/Current time:/g) ?? [];
      assert.equal(currentTimeMatches.length, 1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("timeoutMs 超過時は failed を返し、runOnce がハングしない", async () => {
    const tempDir = await mkdtemp(`${tmpdir()}/adjutant-heartbeat-`);
    try {
      await preparePromptFiles(tempDir, "Heartbeat prompt");
      setHeartbeatRuntimeForTest({
        readEvents: async () => [],
        readMemoryFiles: async () => ({
          longTerm: null,
          daily: null,
          yesterday: null,
        }),
        buildEventContext: () => ({ text: "", truncated: false, eventCount: 0 }),
        getQueueSize: () => 0,
        runAgent: async () => await new Promise(() => undefined),
      });

      const startedAt = Date.now();
      const result = await runOnce(
        {
          ...createBaseConfig(tempDir),
          timeoutMs: 10,
        },
        { reason: "timer" }
      );
      const elapsed = Date.now() - startedAt;

      assert.equal(result.status, "failed");
      if (result.status === "failed") {
        assert.match(result.reason, /timeout/i);
      }
      assert.equal(elapsed < 1000, true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
