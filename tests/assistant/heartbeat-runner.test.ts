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
    retryDelayMs: 5,
  };
}

type HeartbeatToolStatus = "no_action_needed" | "needs_attention" | "task_completed";

function createToolAgentResult(input: {
  status: HeartbeatToolStatus;
  notify: boolean;
  reason: string;
  modelId?: string;
}) {
  return {
    text: input.reason,
    modelId: input.modelId ?? "gpt-4o-mini",
    toolCalls: [
      {
        name: "report_heartbeat_status",
        result: {
          status: input.status,
          notify: input.notify,
          reason: input.reason,
        },
      },
    ],
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
          return createToolAgentResult({
            status: "no_action_needed",
            notify: false,
            reason: "periodic heartbeat ok",
          });
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
        runAgent: async () =>
          createToolAgentResult({
            status: "needs_attention",
            notify: true,
            reason: "ALERT: investigate #incident immediately",
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
        runAgent: async () =>
          createToolAgentResult({
            status: "needs_attention",
            notify: true,
            reason: "ALERT: notify now",
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
        runAgent: async () =>
          createToolAgentResult({
            status: "needs_attention",
            notify: true,
            reason: "ALERT: notify now",
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
          return createToolAgentResult({
            status: "no_action_needed",
            notify: false,
            reason: "unexpected",
          });
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

  it("report_heartbeat_status ツール呼び出しが無いと failed になる", async () => {
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
        runAgent: async () => ({ text: "legacy-text-only", modelId: "gpt-4o-mini" }),
      });

      const result = await runOnce(createBaseConfig(tempDir));
      assert.deepEqual(result, {
        status: "failed",
        reason: "missing-report-heartbeat-status-tool-call",
      });
      const evt = getLastHeartbeatEvent();
      assert.equal(evt?.status, "failed");
      assert.equal(evt?.reason, "missing-report-heartbeat-status-tool-call");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("status=no_action_needed は ok-empty 扱いで ran を返す", async () => {
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
        runAgent: async () =>
          createToolAgentResult({
            status: "no_action_needed",
            notify: false,
            reason: "all good",
          }),
      });

      const result = await runOnce(createBaseConfig(tempDir), { reason: "timer" });
      assert.equal(result.status, "ran");
      const payload = getLastHeartbeatEvent();
      assert.equal(payload?.status, "ok-empty");
      assert.equal(payload?.indicatorType, "ok");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("status=needs_attention かつ notify=true は sent になる", async () => {
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
        runAgent: async () =>
          createToolAgentResult({
            status: "needs_attention",
            notify: true,
            reason: "ALERT: #incident に障害報告がありました。詳細を確認してください。",
          }),
      });

      const result = await runOnce(createBaseConfig(tempDir), { reason: "timer" });
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

  it("status=needs_attention でも notify=false なら ok-empty で通知しない", async () => {
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
        runAgent: async () =>
          createToolAgentResult({
            status: "needs_attention",
            notify: false,
            reason: "attention noted but no user notify",
          }),
      });

      const result = await runOnce(createBaseConfig(tempDir));
      assert.equal(result.status, "ran");
      if (result.status === "ran") {
        assert.equal(result.alert, undefined);
      }
      const payload = getLastHeartbeatEvent();
      assert.equal(payload?.status, "ok-empty");
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

  it("requests-in-flight は skipped(requests-in-flight)", async () => {
    const tempDir = await mkdtemp(`${tmpdir()}/adjutant-heartbeat-`);
    try {
      await preparePromptFiles(tempDir, "Heartbeat prompt");
      let modelCalled = false;
      setHeartbeatRuntimeForTest({
        getQueueSize: () => 2,
        runAgent: async () => {
          modelCalled = true;
          return createToolAgentResult({
            status: "needs_attention",
            notify: true,
            reason: "unexpected",
          });
        },
      });

      const result = await runOnce(createBaseConfig(tempDir));
      assert.deepEqual(result, { status: "skipped", reason: "requests-in-flight" });
      assert.equal(modelCalled, false);
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
        runAgent: async () =>
          createToolAgentResult({
            status: "needs_attention",
            notify: true,
            reason: "ALERT: notify",
          }),
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

  it("readiness 失敗（ok path）は ran + ok-empty を維持する", async () => {
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
        runAgent: async () =>
          createToolAgentResult({
            status: "task_completed",
            notify: false,
            reason: "all tasks done",
          }),
      });

      const result = await runOnce({
        ...createBaseConfig(tempDir),
        readinessCheck: () => false,
      });

      assert.equal(result.status, "ran");
      const evt = getLastHeartbeatEvent();
      assert.equal(evt?.status, "ok-empty");
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
          return createToolAgentResult({
            status: "needs_attention",
            notify: true,
            reason: "ALERT",
          });
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
          return createToolAgentResult({
            status: "needs_attention",
            notify: true,
            reason: "ALERT",
          });
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
        runAgent: async () =>
          createToolAgentResult({
            status: "needs_attention",
            notify: true,
            reason: "ALERT: duplicate content",
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
        runAgent: async () =>
          createToolAgentResult({
            status: "needs_attention",
            notify: true,
            reason: "ALERT: persistent content",
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
        runAgent: async () =>
          createToolAgentResult({
            status: "needs_attention",
            notify: true,
            reason: "ALERT: persistent content",
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
          return createToolAgentResult({
            status: "no_action_needed",
            notify: false,
            reason: "ok",
          });
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

  it("Heartbeat は globalConcurrencyQueue source=heartbeat で acquire/release する", async () => {
    const tempDir = await mkdtemp(`${tmpdir()}/adjutant-heartbeat-`);
    try {
      await preparePromptFiles(tempDir, "Heartbeat prompt");
      const acquiredSources: string[] = [];
      let releaseCount = 0;

      const globalConcurrencyQueue = {
        acquire: async ({
          source,
        }: {
          source: "heartbeat" | "dm" | "group" | "channel" | "flusher";
        }) => {
          acquiredSources.push(source);
          return {
            id: "lease-hb-1",
            source,
            release: () => {
              releaseCount += 1;
            },
          };
        },
        release: () => undefined,
        getSnapshot: () => ({
          running: 0,
          dmRunning: 0,
          waiting: 0,
          totalSlots: 4,
          maxConcurrent: 3,
          maxRunningDM: 3,
        }),
      };

      setHeartbeatRuntimeForTest({
        readEvents: async () => [],
        readMemoryFiles: async () => ({
          longTerm: null,
          daily: null,
          yesterday: null,
        }),
        buildEventContext: () => ({ text: "", truncated: false, eventCount: 0 }),
        getQueueSize: () => 0,
        runAgent: async () =>
          createToolAgentResult({
            status: "no_action_needed",
            notify: false,
            reason: "ok",
          }),
      });

      const result = await runOnce({
        ...createBaseConfig(tempDir),
        globalConcurrencyQueue,
      });

      assert.equal(result.status, "ran");
      assert.deepEqual(acquiredSources, ["heartbeat"]);
      assert.equal(releaseCount, 1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
