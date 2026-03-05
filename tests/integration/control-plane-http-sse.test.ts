import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nodeTest, { type TestContext } from "node:test";

const DEFAULT_TEST_TIMEOUT_SECONDS = 60;

const test = (
  name: string,
  timeoutSeconds: number,
  fn: (t: TestContext) => Promise<void> | void
): void => {
  nodeTest(name, { timeout: timeoutSeconds * 1000 }, fn);
};

type CommandAccepted = {
  messageId: string;
  status: "accepted";
  acceptedAt: string;
  runId: string;
  sessionRecovered?: boolean;
  sessionRecoveryMode?: string;
  sessionRecoveryReason?: string;
};

type ChatAccepted = {
  runId: string;
  status: "accepted";
};

type ChatStreamEvent = {
  seq: number;
  state: "delta" | "final" | "aborted" | "error";
  runId: string;
  sessionKey: string;
  message?: string;
  errorMessage?: string;
  toolCallId?: string;
  toolName?: string;
  toolStatus?: "started" | "completed" | "failed";
  toolInput?: unknown;
  toolOutput?: unknown;
  toolError?: string;
};

type ChatHistoryResponse = {
  messages: Array<{
    role: "user" | "assistant";
    content: string;
    runId?: string;
  }>;
};

type SnapshotResponse = {
  runs: Array<{
    runId: string;
    status: string;
    sessionRecoveryMode?: string;
    sessionRecovered?: boolean;
    sessionRecoveryReason?: string;
  }>;
  toolEventsByRun: Record<
    string,
    Array<{
      toolCallId: string;
      status: string;
      rawInput?: unknown;
      rawOutput?: unknown;
      error?: string;
    }>
  >;
  pendingPermissions: unknown[];
};

type ThreadRecord = {
  threadId: string;
  title: string;
  archived: boolean;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
};

type ThreadSnapshotResponse = SnapshotResponse & {
  thread: ThreadRecord;
};

type RunAuditResponse = {
  runId: string;
  runEnded: boolean;
  runStatus?: "ok" | "aborted" | "error";
  tools: Array<{
    toolCallId?: string;
    status?: "ok" | "error";
  }>;
  summaryBatches?: Array<{
    status?: "ok" | "error";
  }>;
};

type SseEvent = {
  event: string;
  data: Record<string, unknown>;
};

type SseConnection = {
  events: SseEvent[];
  waitFor: (predicate: (event: SseEvent) => boolean, timeoutMs?: number) => Promise<SseEvent>;
  close: () => void;
};

function waitForCondition<T>(
  values: T[],
  predicate: (value: T) => boolean,
  timeoutMs = 5000
): Promise<T> {
  const found = values.find(predicate);
  if (found !== undefined) {
    return Promise.resolve(found);
  }

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      const candidate = values.find(predicate);
      if (candidate !== undefined) {
        clearInterval(timer);
        resolve(candidate);
        return;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        clearInterval(timer);
        reject(new Error("timeout"));
      }
    }, 20);
  });
}

function parseRunId(runId: string): { sessionId: string; runSequence: number } {
  const matched = /^session:(.+):run:(\d+)$/.exec(runId);
  if (matched === null) {
    throw new Error(`unexpected runId format: ${runId}`);
  }
  return {
    sessionId: matched[1] ?? "",
    runSequence: Number.parseInt(matched[2] ?? "0", 10),
  };
}

async function allocatePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close(() => reject(new Error("failed to allocate port")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function waitForHttpReady(baseUrl: string, timeoutMs = 30000): Promise<void> {
  const startedAt = Date.now();

  while (true) {
    try {
      const response = await fetch(`${baseUrl}/api/snapshot`);
      if (response.ok) {
        return;
      }
    } catch {
      // retry until timeout
    }
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error("control-plane bootstrap timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function startControlPlane(options?: { env?: Record<string, string | undefined> }): Promise<{
  baseUrl: string;
  child: ChildProcessWithoutNullStreams;
}> {
  const port = await allocatePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const requestedStateDir = options?.env?.ADJUTANT_STATE_DIR?.trim();
  const stateDir =
    requestedStateDir !== undefined && requestedStateDir.length > 0
      ? requestedStateDir
      : await mkdtemp(join(tmpdir(), "adjutant-control-plane-http-sse-"));

  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      ...(options?.env ?? {}),
      ADJUTANT_CONTROL_PLANE_HOST: "127.0.0.1",
      ADJUTANT_CONTROL_PLANE_PORT: String(port),
      ADJUTANT_UI_VITE_MIDDLEWARE: "0",
      ADJUTANT_MARKDOWN_SUMMARY_BATCH_ENABLED: "0",
      ADJUTANT_STATE_DIR: stateDir,
    },
  });

  let logs = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    logs += chunk;
  });
  child.stderr.on("data", (chunk) => {
    logs += chunk;
  });

  try {
    await waitForHttpReady(baseUrl);
  } catch (error) {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
    throw new Error(
      `failed to start control-plane: ${error instanceof Error ? error.message : String(error)}\n${logs}`
    );
  }

  return { baseUrl, child };
}

async function stopControlPlane(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      resolve();
    }, 3000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function openSsePath(baseUrl: string, path: string): Promise<SseConnection> {
  const response = await fetch(`${baseUrl}${path}`);
  assert.equal(response.status, 200);
  assert.ok(response.body);

  const events: SseEvent[] = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  let cancelled = false;
  let buffer = "";
  void (async () => {
    while (!cancelled) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let delimiterIndex = buffer.indexOf("\n\n");
      while (delimiterIndex >= 0) {
        const block = buffer.slice(0, delimiterIndex);
        buffer = buffer.slice(delimiterIndex + 2);
        const lines = block
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0 && !line.startsWith(":"));
        let eventName = "";
        let dataText = "";
        for (const line of lines) {
          if (line.startsWith("event:")) {
            eventName = line.slice("event:".length).trim();
            continue;
          }
          if (line.startsWith("data:")) {
            dataText += line.slice("data:".length).trim();
          }
        }
        if (eventName.length === 0 || dataText.length === 0) {
          delimiterIndex = buffer.indexOf("\n\n");
          continue;
        }

        events.push({
          event: eventName,
          data: JSON.parse(dataText) as Record<string, unknown>,
        });
        delimiterIndex = buffer.indexOf("\n\n");
      }
    }
  })();

  return {
    events,
    waitFor: async (predicate, timeoutMs = 6000) =>
      await waitForCondition(events, predicate, timeoutMs),
    close: () => {
      cancelled = true;
      void reader.cancel();
    },
  };
}

async function openSse(baseUrl: string): Promise<SseConnection> {
  return await openSsePath(baseUrl, "/api/events/stream");
}

test(
  "control-plane startup launches HTTP listen and worker path",
  DEFAULT_TEST_TIMEOUT_SECONDS,
  async (t) => {
    const runtime = await startControlPlane();
    t.after(async () => {
      await stopControlPlane(runtime.child);
    });

    const rootRes = await fetch(`${runtime.baseUrl}/`);
    assert.equal(rootRes.status, 200);
    const html = await rootRes.text();
    assert.equal(
      html.includes("Adjutant Assistant UI") || html.includes("Adjutant Web UI (co-located)"),
      true
    );
    assert.equal(html.includes('id="root"') || html.includes('id="command-form"'), true);

    const snapshotRes = await fetch(`${runtime.baseUrl}/api/snapshot`);
    assert.equal(snapshotRes.status, 200);
    const snapshot = (await snapshotRes.json()) as SnapshotResponse;
    assert.deepEqual(snapshot.runs, []);
    assert.deepEqual(snapshot.toolEventsByRun, {});
    assert.deepEqual(snapshot.pendingPermissions, []);

    const commandRes = await fetch(`${runtime.baseUrl}/api/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionKey: "main", message: "hello from startup test" }),
    });
    assert.equal(commandRes.status, 202);
    const accepted = (await commandRes.json()) as CommandAccepted;
    assert.equal(accepted.status, "accepted");
    assert.equal(typeof accepted.runId, "string");
    assert.ok(accepted.runId.length > 0);
  }
);

test(
  "POST /api/commands emits accepted -> update -> completed over SSE",
  DEFAULT_TEST_TIMEOUT_SECONDS,
  async (t) => {
    const runtime = await startControlPlane();
    t.after(async () => {
      await stopControlPlane(runtime.child);
    });

    const sse = await openSse(runtime.baseUrl);
    t.after(() => {
      sse.close();
    });

    const commandRes = await fetch(`${runtime.baseUrl}/api/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionKey: "main", message: "hello-sse" }),
    });
    assert.equal(commandRes.status, 202);
    const accepted = (await commandRes.json()) as CommandAccepted;

    const acceptedEvent = await sse.waitFor(
      (event) => event.event === "run/accepted" && event.data.runId === accepted.runId
    );
    assert.equal(acceptedEvent.data.runId, accepted.runId);

    const updateEvent = await sse.waitFor(
      (event) =>
        event.event === "run/update" &&
        event.data.runId === accepted.runId &&
        typeof event.data.update === "object" &&
        event.data.update !== null
    );
    const updatePayload = updateEvent.data.update as Record<string, unknown>;
    assert.equal(updatePayload.sessionUpdate, "agent_message_chunk");

    const completedEvent = await sse.waitFor(
      (event) => event.event === "run/completed" && event.data.runId === accepted.runId
    );
    assert.equal(completedEvent.data.runId, accepted.runId);
    assert.equal(completedEvent.data.stopReason, "end_turn");
  }
);

test(
  "collector/ingest accepted triggers run accepted -> completed and audit linkage",
  DEFAULT_TEST_TIMEOUT_SECONDS,
  async (t) => {
    const stateDir = await mkdtemp(join(tmpdir(), "adjutant-collector-ingest-run-"));
    t.after(async () => {
      await rm(stateDir, { recursive: true, force: true });
    });

    const runtime = await startControlPlane({
      env: {
        ADJUTANT_STATE_DIR: stateDir,
        ADJUTANT_COLLECTOR_SLACK_ENABLED: "1",
        ADJUTANT_COLLECTOR_SLACK_ENTRY:
          "tests/fixtures/collector-slack/mock-collector-ingest-once.ts",
        ADJUTANT_TEST_COLLECTOR_DELAY_MS: "1500",
        ADJUTANT_TEST_MOCK_RUNNER: "1",
        ADJUTANT_TEST_MOCK_TEXT: "collector-ingest-completed",
        ADJUTANT_TEST_MOCK_DELAY_MS: "2000",
        ADJUTANT_AGENT_AUDIT_LOG_ENABLED: "1",
      },
    });
    t.after(async () => {
      await stopControlPlane(runtime.child);
    });

    const sse = await openSse(runtime.baseUrl);
    t.after(() => {
      sse.close();
    });

    const acceptedEvent = await sse.waitFor(
      (event) =>
        event.event === "run/accepted" &&
        typeof event.data.runId === "string" &&
        event.data.runId.startsWith("session:")
    );
    const runId = String(acceptedEvent.data.runId);
    assert.equal(runId.length > 0, true);

    const cursorPath = join(stateDir, "cursor", "control-plane.inbox.json");
    try {
      const rawCursorBeforeTerminal = await readFile(cursorPath, "utf8");
      const before = JSON.parse(rawCursorBeforeTerminal) as { offset?: number };
      assert.equal(before.offset, 0);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw error;
      }
    }

    await sse.waitFor((event) => event.event === "run/completed" && event.data.runId === runId);

    const snapshotRes = await fetch(`${runtime.baseUrl}/api/snapshot`);
    assert.equal(snapshotRes.status, 200);
    const snapshot = (await snapshotRes.json()) as SnapshotResponse;
    const run = snapshot.runs.find((entry) => entry.runId === runId);
    assert.equal(run?.status, "completed");

    const auditRes = await fetch(
      `${runtime.baseUrl}/api/chat/runs/${encodeURIComponent(runId)}/audit`
    );
    assert.equal(auditRes.status, 200);
    const audit = (await auditRes.json()) as RunAuditResponse;
    assert.equal(audit.runId, runId);
    assert.equal(audit.runEnded, true);
    assert.equal(audit.runStatus, "ok");

    const cursorAfterTerminal = JSON.parse(await readFile(cursorPath, "utf8")) as {
      offset?: number;
    };
    assert.equal(cursorAfterTerminal.offset, 1);

    const inboxPath = join(stateDir, "journal", "control-plane", "inbox.jsonl");
    const inboxRaw = await readFile(inboxPath, "utf8");
    assert.equal(inboxRaw.includes('"messageId":"msg_collector_fixture_1"'), true);
  }
);

test(
  "collector/ingest dedupeKey remains canonical after process restart",
  DEFAULT_TEST_TIMEOUT_SECONDS,
  async (t) => {
    const stateDir = await mkdtemp(join(tmpdir(), "adjutant-collector-dedupe-restart-"));
    t.after(async () => {
      await rm(stateDir, { recursive: true, force: true });
    });

    const env = {
      ADJUTANT_STATE_DIR: stateDir,
      ADJUTANT_COLLECTOR_SLACK_ENABLED: "1",
      ADJUTANT_COLLECTOR_SLACK_ENTRY:
        "tests/fixtures/collector-slack/mock-collector-ingest-once.ts",
      ADJUTANT_TEST_COLLECTOR_DELAY_MS: "1200",
      ADJUTANT_TEST_MOCK_RUNNER: "1",
      ADJUTANT_TEST_MOCK_TEXT: "collector-dedupe-restart",
      ADJUTANT_TEST_MOCK_DELAY_MS: "800",
    };

    const runtime1 = await startControlPlane({ env });
    const sse1 = await openSse(runtime1.baseUrl);
    const acceptedEvent = await sse1.waitFor(
      (event) =>
        event.event === "run/accepted" &&
        typeof event.data.runId === "string" &&
        event.data.runId.startsWith("session:")
    );
    const firstRunId = String(acceptedEvent.data.runId);
    await sse1.waitFor(
      (event) => event.event === "run/completed" && event.data.runId === firstRunId
    );
    sse1.close();
    await stopControlPlane(runtime1.child);

    const runtime2 = await startControlPlane({ env });
    t.after(async () => {
      await stopControlPlane(runtime2.child);
    });
    const sse2 = await openSse(runtime2.baseUrl);
    t.after(() => {
      sse2.close();
    });

    await new Promise((resolve) => setTimeout(resolve, 3500));

    const acceptedAfterRestart = sse2.events.filter((event) => {
      return (
        event.event === "run/accepted" &&
        typeof event.data.runId === "string" &&
        event.data.runId !== firstRunId
      );
    });
    assert.equal(acceptedAfterRestart.length, 0);

    const inboxPath = join(stateDir, "journal", "control-plane", "inbox.jsonl");
    const inboxRaw = await readFile(inboxPath, "utf8");
    const lines = inboxRaw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    assert.equal(lines.length, 1);

    const idempotencySnapshotPath = join(
      stateDir,
      "cursor",
      "control-plane.idempotency.snapshot.json"
    );
    const idempotencySnapshot = JSON.parse(await readFile(idempotencySnapshotPath, "utf8")) as {
      entries?: Array<{
        scope?: string;
        key?: string;
        accepted?: { messageId?: string };
      }>;
    };
    const ingestEntry = (idempotencySnapshot.entries ?? []).find((entry) => {
      return entry.scope === "ingest" && entry.key === "slack:C123@1730000000.123";
    });
    assert.equal(ingestEntry?.accepted?.messageId, "msg_collector_fixture_1");
  }
);

test(
  "control-plane replays pending ingest inbox on startup and commits cursor after completion",
  DEFAULT_TEST_TIMEOUT_SECONDS,
  async (t) => {
    const stateDir = await mkdtemp(join(tmpdir(), "adjutant-ingest-replay-startup-"));
    t.after(async () => {
      await rm(stateDir, { recursive: true, force: true });
    });

    const inboxDir = join(stateDir, "journal", "control-plane");
    const cursorDir = join(stateDir, "cursor");
    await mkdir(inboxDir, { recursive: true });
    await mkdir(cursorDir, { recursive: true });

    const replayEntry = {
      version: 1,
      receivedAt: "2026-03-03T12:00:00.000Z",
      request: {
        messageId: "msg_replay_1",
        dedupeKey: "slack:C123@1730000000.321",
        source: "slack",
        occurredAt: "2026-03-03T12:00:00.000Z",
        payload: {
          schema: "adjutant.event.v1.1",
          uid: "slack:C123@1730000000.321",
          source: "slack",
          kind: "post",
          ts: "2026-03-03T12:00:00.000Z",
          detail: {
            slack: {
              channel_id: "C123",
              message_ts: "1730000000.321",
              text: "startup replay message",
            },
          },
        },
      },
      projection: {
        sessionKey: "slack:channel:C123",
        message: "[Slack post] channel=C123 text=startup replay message",
        dedupeKey: "slack:C123@1730000000.321",
        source: "slack",
        occurredAt: "2026-03-03T12:00:00.000Z",
        rawEvent: {
          schema: "adjutant.event.v1.1",
          uid: "slack:C123@1730000000.321",
          source: "slack",
          kind: "post",
          ts: "2026-03-03T12:00:00.000Z",
          detail: {
            slack: {
              channel_id: "C123",
              message_ts: "1730000000.321",
              text: "startup replay message",
            },
          },
        },
      },
    };
    await writeFile(join(inboxDir, "inbox.jsonl"), `${JSON.stringify(replayEntry)}\n`, "utf8");
    await writeFile(join(cursorDir, "control-plane.inbox.json"), '{"segment":0,"offset":0}\n');

    const runtime = await startControlPlane({
      env: {
        ADJUTANT_STATE_DIR: stateDir,
        ADJUTANT_COLLECTOR_SLACK_ENABLED: "0",
        ADJUTANT_TEST_MOCK_RUNNER: "1",
        ADJUTANT_TEST_MOCK_TEXT: "startup-replay-completed",
      },
    });
    t.after(async () => {
      await stopControlPlane(runtime.child);
    });

    const startedAt = Date.now();

    while (true) {
      const snapshotRes = await fetch(`${runtime.baseUrl}/api/snapshot`);
      assert.equal(snapshotRes.status, 200);
      const snapshot = (await snapshotRes.json()) as SnapshotResponse;
      const hasCompleted = snapshot.runs.some((run) => run.status === "completed");
      if (hasCompleted) {
        break;
      }
      if (Date.now() - startedAt >= 10_000) {
        throw new Error("ingest replay completion timeout");
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const cursor = JSON.parse(
      await readFile(join(cursorDir, "control-plane.inbox.json"), "utf8")
    ) as {
      offset?: number;
    };
    assert.equal(cursor.offset, 1);
  }
);

test(
  "POST /api/commands dedupes same idempotencyKey and rejects conflicting payload",
  DEFAULT_TEST_TIMEOUT_SECONDS,
  async (t) => {
    const runtime = await startControlPlane();
    t.after(async () => {
      await stopControlPlane(runtime.child);
    });

    const firstRes = await fetch(`${runtime.baseUrl}/api/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionKey: "main",
        message: "idempotent-hello",
        idempotencyKey: "dup_1",
      }),
    });
    assert.equal(firstRes.status, 202);
    const first = (await firstRes.json()) as CommandAccepted;

    const secondRes = await fetch(`${runtime.baseUrl}/api/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionKey: "main",
        message: "idempotent-hello",
        idempotencyKey: "dup_1",
      }),
    });
    assert.equal(secondRes.status, 202);
    const second = (await secondRes.json()) as CommandAccepted;
    assert.equal(second.runId, first.runId);

    const startedAt = Date.now();

    while (true) {
      const snapshotRes = await fetch(`${runtime.baseUrl}/api/snapshot`);
      const snapshot = (await snapshotRes.json()) as SnapshotResponse;
      if (snapshot.runs.some((run) => run.runId === first.runId && run.status === "completed")) {
        break;
      }
      if (Date.now() - startedAt > 8000) {
        throw new Error("idempotency run completion timeout");
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const snapshotRes = await fetch(`${runtime.baseUrl}/api/snapshot`);
    assert.equal(snapshotRes.status, 200);
    const snapshot = (await snapshotRes.json()) as SnapshotResponse;
    const sameRunCount = snapshot.runs.filter((run) => run.runId === first.runId).length;
    assert.equal(sameRunCount, 1);

    const conflictRes = await fetch(`${runtime.baseUrl}/api/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionKey: "main",
        message: "different-payload",
        idempotencyKey: "dup_1",
      }),
    });
    assert.equal(conflictRes.status, 409);
    const conflict = (await conflictRes.json()) as { code?: string; message?: string };
    assert.equal(conflict.code, "INVALID_REQUEST");
  }
);

test(
  "POST /api/commands keeps idempotency duplicate/conflict after process restart",
  DEFAULT_TEST_TIMEOUT_SECONDS,
  async (t) => {
    const stateDir = await mkdtemp(join(tmpdir(), "adjutant-idempotency-restart-"));
    t.after(async () => {
      await rm(stateDir, { recursive: true, force: true });
    });

    const env = {
      ADJUTANT_STATE_DIR: stateDir,
      ADJUTANT_TEST_MOCK_RUNNER: "1",
      ADJUTANT_TEST_MOCK_TEXT: "idempotency-restart-completed",
    };

    const runtime1 = await startControlPlane({ env });
    const firstRes = await fetch(`${runtime1.baseUrl}/api/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionKey: "main",
        message: "idempotent-restart",
        idempotencyKey: "dup_restart_1",
      }),
    });
    assert.equal(firstRes.status, 202);
    const first = (await firstRes.json()) as CommandAccepted;
    await stopControlPlane(runtime1.child);

    const runtime2 = await startControlPlane({ env });
    t.after(async () => {
      await stopControlPlane(runtime2.child);
    });

    const secondRes = await fetch(`${runtime2.baseUrl}/api/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionKey: "main",
        message: "idempotent-restart",
        idempotencyKey: "dup_restart_1",
      }),
    });
    assert.equal(secondRes.status, 202);
    const second = (await secondRes.json()) as CommandAccepted;
    assert.equal(second.runId, first.runId);

    const conflictRes = await fetch(`${runtime2.baseUrl}/api/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionKey: "main",
        message: "different-after-restart",
        idempotencyKey: "dup_restart_1",
      }),
    });
    assert.equal(conflictRes.status, 409);
    const conflict = (await conflictRes.json()) as { code?: string };
    assert.equal(conflict.code, "INVALID_REQUEST");
  }
);

test(
  "POST /api/chat/messages validates request and returns accepted subset",
  DEFAULT_TEST_TIMEOUT_SECONDS,
  async (t) => {
    const runtime = await startControlPlane();
    t.after(async () => {
      await stopControlPlane(runtime.child);
    });

    const invalidRes = await fetch(`${runtime.baseUrl}/api/chat/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionKey: "main", message: "hello" }),
    });
    assert.equal(invalidRes.status, 400);

    const commandRes = await fetch(`${runtime.baseUrl}/api/chat/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionKey: "main",
        message: "hello-chat",
        idempotencyKey: "chat_accepted_1",
      }),
    });
    assert.equal(commandRes.status, 202);
    const accepted = (await commandRes.json()) as ChatAccepted & Record<string, unknown>;
    assert.equal(accepted.status, "accepted");
    assert.equal(typeof accepted.runId, "string");
    assert.equal("messageId" in accepted, false);
  }
);

test(
  "control-plane replays only pending deliver queue records on startup",
  DEFAULT_TEST_TIMEOUT_SECONDS,
  async (t) => {
    const stateDir = await mkdtemp(join(tmpdir(), "adjutant-deliver-replay-startup-"));
    t.after(async () => {
      await rm(stateDir, { recursive: true, force: true });
    });

    const queueJournalDir = join(stateDir, "journal", "control-plane");
    const cursorDir = join(stateDir, "cursor");
    await mkdir(queueJournalDir, { recursive: true });
    await mkdir(cursorDir, { recursive: true });

    const queueEntries = [
      {
        version: 1,
        enqueuedAt: "2026-03-04T01:00:00.000Z",
        request: {
          messageId: "msg_deliver_replay_done",
          dedupeKey: "deliver:msg_deliver_replay_done",
          target: "slack",
          payload: { text: "already done" },
          attempt: 1,
          maxAttempts: 3,
        },
        nextAttemptAt: "2026-03-04T01:00:00.000Z",
        state: "pending",
      },
      {
        version: 1,
        enqueuedAt: "2026-03-04T01:00:01.000Z",
        request: {
          messageId: "msg_deliver_replay_pending",
          dedupeKey: "deliver:msg_deliver_replay_pending",
          target: "slack",
          payload: { text: "pending replay" },
          attempt: 1,
          maxAttempts: 3,
        },
        nextAttemptAt: "2026-03-04T01:00:01.000Z",
        state: "pending",
      },
    ];
    await writeFile(
      join(queueJournalDir, "deliver-queue.jsonl"),
      `${queueEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf8"
    );
    await writeFile(
      join(cursorDir, "control-plane.deliver-queue.json"),
      '{"segment":0,"offset":1}\n',
      "utf8"
    );

    const runtime = await startControlPlane({
      env: {
        ADJUTANT_STATE_DIR: stateDir,
        ADJUTANT_COLLECTOR_SLACK_ENABLED: "0",
        ADJUTANT_TEST_MOCK_RUNNER: "1",
        ADJUTANT_DELIVER_SLACK_ENABLED: "1",
        ADJUTANT_DELIVER_SLACK_AUTO_COMPLETE: "1",
        ADJUTANT_DELIVER_SLACK_COMPLETION_DELAY_MS: "0",
      },
    });
    t.after(async () => {
      await stopControlPlane(runtime.child);
    });

    const startedAt = Date.now();
    while (true) {
      const cursor = JSON.parse(
        await readFile(join(cursorDir, "control-plane.deliver-queue.json"), "utf8")
      ) as {
        offset?: number;
      };
      if (cursor.offset === 2) {
        break;
      }
      if (Date.now() - startedAt > 8_000) {
        throw new Error("deliver replay cursor commit timeout");
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
);

test(
  "POST /api/chat/messages supports idempotency dedupe and conflict",
  DEFAULT_TEST_TIMEOUT_SECONDS,
  async (t) => {
    const runtime = await startControlPlane();
    t.after(async () => {
      await stopControlPlane(runtime.child);
    });

    const firstRes = await fetch(`${runtime.baseUrl}/api/chat/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionKey: "main",
        message: "idempotent-chat",
        idempotencyKey: "chat_dup_1",
      }),
    });
    assert.equal(firstRes.status, 202);
    const first = (await firstRes.json()) as ChatAccepted;

    const secondRes = await fetch(`${runtime.baseUrl}/api/chat/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionKey: "main",
        message: "idempotent-chat",
        idempotencyKey: "chat_dup_1",
      }),
    });
    assert.equal(secondRes.status, 202);
    const second = (await secondRes.json()) as ChatAccepted;
    assert.equal(second.runId, first.runId);

    const conflictRes = await fetch(`${runtime.baseUrl}/api/chat/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionKey: "main",
        message: "different-chat",
        idempotencyKey: "chat_dup_1",
      }),
    });
    assert.equal(conflictRes.status, 409);
    const conflict = (await conflictRes.json()) as { code?: string };
    assert.equal(conflict.code, "INVALID_REQUEST");
  }
);

test(
  "GET /api/chat/runs/{runId}/stream provides chat SSE and seq replay",
  DEFAULT_TEST_TIMEOUT_SECONDS,
  async (t) => {
    const runtime = await startControlPlane({
      env: {
        ADJUTANT_TEST_MOCK_RUNNER: "1",
        ADJUTANT_TEST_MOCK_DELTA: "stream-delta",
        ADJUTANT_TEST_MOCK_TEXT: "stream-final",
        ADJUTANT_TEST_MOCK_STOP_REASON: "end_turn",
      },
    });
    t.after(async () => {
      await stopControlPlane(runtime.child);
    });

    const commandRes = await fetch(`${runtime.baseUrl}/api/chat/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionKey: "main",
        message: "hello-stream",
        idempotencyKey: "chat_stream_1",
      }),
    });
    assert.equal(commandRes.status, 202);
    const accepted = (await commandRes.json()) as ChatAccepted;

    const stream = await openSsePath(
      runtime.baseUrl,
      `/api/chat/runs/${encodeURIComponent(accepted.runId)}/stream?seq=0`
    );
    t.after(() => {
      stream.close();
    });

    await stream.waitFor(
      (event) =>
        event.event === "chat" &&
        (event.data as Record<string, unknown>).runId === accepted.runId &&
        (event.data as Record<string, unknown>).state === "final"
    );

    const chatEvents = stream.events
      .filter((event) => event.event === "chat")
      .map((event) => event.data as unknown as ChatStreamEvent)
      .filter((event) => event.runId === accepted.runId);
    assert.equal(
      chatEvents.some((event) => event.state === "delta"),
      true
    );
    assert.equal(
      chatEvents.some((event) => event.state === "final"),
      true
    );

    const maxSeq = Math.max(...chatEvents.map((event) => event.seq));
    const replay = await openSsePath(
      runtime.baseUrl,
      `/api/chat/runs/${encodeURIComponent(accepted.runId)}/stream?seq=${maxSeq}`
    );
    t.after(() => {
      replay.close();
    });
    await replay.waitFor(
      (event) =>
        event.event === "chat" &&
        (event.data as Record<string, unknown>).runId === accepted.runId &&
        typeof (event.data as Record<string, unknown>).seq === "number"
    );
    const replayEvent = replay.events.find((event) => event.event === "chat");
    assert.equal(typeof replayEvent?.data.seq, "number");
    assert.equal((replayEvent?.data.seq as number) >= maxSeq, true);

    const missingRes = await fetch(
      `${runtime.baseUrl}/api/chat/runs/${encodeURIComponent("session:missing:run:1")}/stream`
    );
    assert.equal(missingRes.status, 404);
  }
);

test(
  "GET /api/chat/history validates sessionKey and returns messages",
  DEFAULT_TEST_TIMEOUT_SECONDS,
  async (t) => {
    const runtime = await startControlPlane({
      env: {
        ADJUTANT_TEST_MOCK_RUNNER: "1",
        ADJUTANT_TEST_MOCK_DELTA: "h-delta",
        ADJUTANT_TEST_MOCK_TEXT: "h-final",
      },
    });
    t.after(async () => {
      await stopControlPlane(runtime.child);
    });

    const commandRes = await fetch(`${runtime.baseUrl}/api/chat/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionKey: "main",
        message: "history-message",
        idempotencyKey: "chat_history_1",
      }),
    });
    assert.equal(commandRes.status, 202);
    const accepted = (await commandRes.json()) as ChatAccepted;

    const stream = await openSsePath(
      runtime.baseUrl,
      `/api/chat/runs/${encodeURIComponent(accepted.runId)}/stream`
    );
    t.after(() => {
      stream.close();
    });
    await stream.waitFor(
      (event) =>
        event.event === "chat" &&
        (event.data as Record<string, unknown>).runId === accepted.runId &&
        (event.data as Record<string, unknown>).state === "final"
    );

    const missingRes = await fetch(`${runtime.baseUrl}/api/chat/history`);
    assert.equal(missingRes.status, 400);

    const historyRes = await fetch(`${runtime.baseUrl}/api/chat/history?sessionKey=main`);
    assert.equal(historyRes.status, 200);
    const history = (await historyRes.json()) as ChatHistoryResponse;
    assert.equal(history.messages.length >= 2, true);
    assert.equal(history.messages[0]?.role, "user");
    assert.equal(history.messages[1]?.role, "assistant");
  }
);

test(
  "GET /api/threads returns main virtual entry first and main is materialized on first message",
  DEFAULT_TEST_TIMEOUT_SECONDS,
  async (t) => {
    const stateDir = await mkdtemp(join(tmpdir(), "adjutant-thread-main-"));
    const runtime = await startControlPlane({
      env: {
        ADJUTANT_STATE_DIR: stateDir,
        ADJUTANT_TEST_MOCK_RUNNER: "1",
        ADJUTANT_TEST_MOCK_DELTA: "thread-delta",
        ADJUTANT_TEST_MOCK_TEXT: "thread-final",
      },
    });
    t.after(async () => {
      await stopControlPlane(runtime.child);
    });
    t.after(async () => {
      await rm(stateDir, { recursive: true, force: true });
    });

    const beforeListRes = await fetch(`${runtime.baseUrl}/api/threads`);
    assert.equal(beforeListRes.status, 200);
    const beforeList = (await beforeListRes.json()) as ThreadRecord[];
    assert.equal(beforeList[0]?.threadId, "main");
    assert.equal(beforeList[0]?.createdAt, "1970-01-01T00:00:00.000Z");

    const commandRes = await fetch(`${runtime.baseUrl}/api/chat/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionKey: "main",
        message: "materialize-main-thread",
        idempotencyKey: "thread_materialize_main_1",
      }),
    });
    assert.equal(commandRes.status, 202);
    const accepted = (await commandRes.json()) as ChatAccepted;

    const stream = await openSsePath(
      runtime.baseUrl,
      `/api/chat/runs/${encodeURIComponent(accepted.runId)}/stream?seq=0`
    );
    t.after(() => {
      stream.close();
    });
    await stream.waitFor(
      (event) =>
        event.event === "chat" &&
        event.data.runId === accepted.runId &&
        event.data.state === "final"
    );

    const afterListRes = await fetch(`${runtime.baseUrl}/api/threads`);
    assert.equal(afterListRes.status, 200);
    const afterList = (await afterListRes.json()) as ThreadRecord[];
    assert.equal(afterList[0]?.threadId, "main");
    assert.notEqual(afterList[0]?.createdAt, "1970-01-01T00:00:00.000Z");
  }
);

test(
  "POST/GET/PATCH/DELETE /api/threads works and PATCH rejects forbidden fields",
  DEFAULT_TEST_TIMEOUT_SECONDS,
  async (t) => {
    const runtime = await startControlPlane();
    t.after(async () => {
      await stopControlPlane(runtime.child);
    });

    const createRes = await fetch(`${runtime.baseUrl}/api/threads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Thread One" }),
    });
    assert.equal(createRes.status, 201);
    const created = (await createRes.json()) as ThreadRecord;
    assert.equal(created.threadId.startsWith("thr_"), true);
    assert.equal(created.title, "Thread One");

    const getRes = await fetch(
      `${runtime.baseUrl}/api/threads/${encodeURIComponent(created.threadId)}`
    );
    assert.equal(getRes.status, 200);
    const fetched = (await getRes.json()) as ThreadRecord;
    assert.equal(fetched.threadId, created.threadId);

    const invalidPatchRes = await fetch(
      `${runtime.baseUrl}/api/threads/${encodeURIComponent(created.threadId)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ threadId: "tamper" }),
      }
    );
    assert.equal(invalidPatchRes.status, 400);

    const emptyPatchRes = await fetch(
      `${runtime.baseUrl}/api/threads/${encodeURIComponent(created.threadId)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }
    );
    assert.equal(emptyPatchRes.status, 400);

    const patchRes = await fetch(
      `${runtime.baseUrl}/api/threads/${encodeURIComponent(created.threadId)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Renamed", archived: true }),
      }
    );
    assert.equal(patchRes.status, 200);
    const patched = (await patchRes.json()) as ThreadRecord;
    assert.equal(patched.title, "Renamed");
    assert.equal(patched.archived, true);

    const deleteMainRes = await fetch(`${runtime.baseUrl}/api/threads/main`, {
      method: "DELETE",
    });
    assert.equal(deleteMainRes.status, 403);

    const deleteRes = await fetch(
      `${runtime.baseUrl}/api/threads/${encodeURIComponent(created.threadId)}`,
      {
        method: "DELETE",
      }
    );
    assert.equal(deleteRes.status, 204);

    const getAfterDeleteRes = await fetch(
      `${runtime.baseUrl}/api/threads/${encodeURIComponent(created.threadId)}`
    );
    assert.equal(getAfterDeleteRes.status, 404);
  }
);

test(
  "thread 切替時に chat history が thread 単位で分離される",
  DEFAULT_TEST_TIMEOUT_SECONDS,
  async (t) => {
    const runtime = await startControlPlane({
      env: {
        ADJUTANT_TEST_MOCK_RUNNER: "1",
        ADJUTANT_TEST_MOCK_DELTA: "switch-delta",
        ADJUTANT_TEST_MOCK_TEXT: "switch-final",
      },
    });
    t.after(async () => {
      await stopControlPlane(runtime.child);
    });

    const createRes = await fetch(`${runtime.baseUrl}/api/threads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Thread-B" }),
    });
    assert.equal(createRes.status, 201);
    const threadB = (await createRes.json()) as ThreadRecord;

    const mainRunRes = await fetch(`${runtime.baseUrl}/api/chat/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionKey: "main",
        message: "message-in-main",
        idempotencyKey: "thread_switch_main_1",
      }),
    });
    assert.equal(mainRunRes.status, 202);
    const mainAccepted = (await mainRunRes.json()) as ChatAccepted;

    const mainStream = await openSsePath(
      runtime.baseUrl,
      `/api/chat/runs/${encodeURIComponent(mainAccepted.runId)}/stream?seq=0`
    );
    t.after(() => {
      mainStream.close();
    });
    await mainStream.waitFor(
      (event) =>
        event.event === "chat" &&
        event.data.runId === mainAccepted.runId &&
        event.data.state === "final"
    );

    const threadBRunRes = await fetch(`${runtime.baseUrl}/api/chat/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionKey: threadB.threadId,
        message: "message-in-thread-b",
        idempotencyKey: "thread_switch_b_1",
      }),
    });
    assert.equal(threadBRunRes.status, 202);
    const threadBAccepted = (await threadBRunRes.json()) as ChatAccepted;

    const threadBStream = await openSsePath(
      runtime.baseUrl,
      `/api/chat/runs/${encodeURIComponent(threadBAccepted.runId)}/stream?seq=0`
    );
    t.after(() => {
      threadBStream.close();
    });
    await threadBStream.waitFor(
      (event) =>
        event.event === "chat" &&
        event.data.runId === threadBAccepted.runId &&
        event.data.state === "final"
    );

    const mainHistoryRes = await fetch(`${runtime.baseUrl}/api/chat/history?sessionKey=main`);
    assert.equal(mainHistoryRes.status, 200);
    const mainHistory = (await mainHistoryRes.json()) as ChatHistoryResponse;
    const mainContents = mainHistory.messages.map((message) => message.content);
    assert.equal(mainContents.includes("message-in-main"), true);
    assert.equal(mainContents.includes("message-in-thread-b"), false);

    const threadBHistoryRes = await fetch(
      `${runtime.baseUrl}/api/chat/history?sessionKey=${encodeURIComponent(threadB.threadId)}`
    );
    assert.equal(threadBHistoryRes.status, 200);
    const threadBHistory = (await threadBHistoryRes.json()) as ChatHistoryResponse;
    const threadBContents = threadBHistory.messages.map((message) => message.content);
    assert.equal(threadBContents.includes("message-in-thread-b"), true);
    assert.equal(threadBContents.includes("message-in-main"), false);
  }
);

test("マルチスレッド E2E: A/B 分離と再読込後の復元", DEFAULT_TEST_TIMEOUT_SECONDS, async (t) => {
  const runtime = await startControlPlane({
    env: {
      ADJUTANT_TEST_MOCK_RUNNER: "1",
      ADJUTANT_TEST_MOCK_DELTA: "multi-delta",
      ADJUTANT_TEST_MOCK_TEXT: "multi-final",
    },
  });
  t.after(async () => {
    await stopControlPlane(runtime.child);
  });

  const createARes = await fetch(`${runtime.baseUrl}/api/threads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Thread-A" }),
  });
  assert.equal(createARes.status, 201);
  const threadA = (await createARes.json()) as ThreadRecord;

  const createBRes = await fetch(`${runtime.baseUrl}/api/threads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Thread-B" }),
  });
  assert.equal(createBRes.status, 201);
  const threadB = (await createBRes.json()) as ThreadRecord;

  const runARes = await fetch(`${runtime.baseUrl}/api/chat/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionKey: threadA.threadId,
      message: "A-hello",
      idempotencyKey: "multi_a_1",
    }),
  });
  assert.equal(runARes.status, 202);
  const acceptedA = (await runARes.json()) as ChatAccepted;

  const streamA = await openSsePath(
    runtime.baseUrl,
    `/api/chat/runs/${encodeURIComponent(acceptedA.runId)}/stream?seq=0`
  );
  t.after(() => {
    streamA.close();
  });
  await streamA.waitFor(
    (event) =>
      event.event === "chat" && event.data.runId === acceptedA.runId && event.data.state === "final"
  );

  const runBRes = await fetch(`${runtime.baseUrl}/api/chat/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionKey: threadB.threadId,
      message: "B-hello",
      idempotencyKey: "multi_b_1",
    }),
  });
  assert.equal(runBRes.status, 202);
  const acceptedB = (await runBRes.json()) as ChatAccepted;

  const streamB = await openSsePath(
    runtime.baseUrl,
    `/api/chat/runs/${encodeURIComponent(acceptedB.runId)}/stream?seq=0`
  );
  t.after(() => {
    streamB.close();
  });
  await streamB.waitFor(
    (event) =>
      event.event === "chat" && event.data.runId === acceptedB.runId && event.data.state === "final"
  );

  const listRes = await fetch(`${runtime.baseUrl}/api/threads`);
  assert.equal(listRes.status, 200);
  const threads = (await listRes.json()) as ThreadRecord[];
  assert.equal(
    threads.some((thread) => thread.threadId === threadA.threadId),
    true
  );
  assert.equal(
    threads.some((thread) => thread.threadId === threadB.threadId),
    true
  );
  assert.equal(threads[0]?.threadId, "main");

  const firstHistoryARes = await fetch(
    `${runtime.baseUrl}/api/chat/history?sessionKey=${encodeURIComponent(threadA.threadId)}`
  );
  assert.equal(firstHistoryARes.status, 200);
  const firstHistoryA = (await firstHistoryARes.json()) as ChatHistoryResponse;

  const firstHistoryBRes = await fetch(
    `${runtime.baseUrl}/api/chat/history?sessionKey=${encodeURIComponent(threadB.threadId)}`
  );
  assert.equal(firstHistoryBRes.status, 200);
  const firstHistoryB = (await firstHistoryBRes.json()) as ChatHistoryResponse;

  assert.equal(
    firstHistoryA.messages.some((message) => message.content === "A-hello"),
    true
  );
  assert.equal(
    firstHistoryA.messages.some((message) => message.content === "B-hello"),
    false
  );
  assert.equal(
    firstHistoryB.messages.some((message) => message.content === "B-hello"),
    true
  );
  assert.equal(
    firstHistoryB.messages.some((message) => message.content === "A-hello"),
    false
  );

  // 再読込相当: 一覧と履歴を再取得して内容が維持されることを確認する。
  const reloadListRes = await fetch(`${runtime.baseUrl}/api/threads`);
  assert.equal(reloadListRes.status, 200);
  const reloadThreads = (await reloadListRes.json()) as ThreadRecord[];
  assert.equal(
    reloadThreads.some((thread) => thread.threadId === threadA.threadId),
    true
  );
  assert.equal(
    reloadThreads.some((thread) => thread.threadId === threadB.threadId),
    true
  );

  const reloadHistoryARes = await fetch(
    `${runtime.baseUrl}/api/chat/history?sessionKey=${encodeURIComponent(threadA.threadId)}`
  );
  assert.equal(reloadHistoryARes.status, 200);
  const reloadHistoryA = (await reloadHistoryARes.json()) as ChatHistoryResponse;
  assert.equal(reloadHistoryA.messages.length, firstHistoryA.messages.length);

  const reloadHistoryBRes = await fetch(
    `${runtime.baseUrl}/api/chat/history?sessionKey=${encodeURIComponent(threadB.threadId)}`
  );
  assert.equal(reloadHistoryBRes.status, 200);
  const reloadHistoryB = (await reloadHistoryBRes.json()) as ChatHistoryResponse;
  assert.equal(reloadHistoryB.messages.length, firstHistoryB.messages.length);
});

test(
  "GET /api/threads/:threadId/snapshot returns run/tool history scoped by thread",
  DEFAULT_TEST_TIMEOUT_SECONDS,
  async (t) => {
    const runtime = await startControlPlane({
      env: {
        ADJUTANT_TEST_FAKE_TOOL_CALLS: "1",
      },
    });
    t.after(async () => {
      await stopControlPlane(runtime.child);
    });

    const createRes = await fetch(`${runtime.baseUrl}/api/threads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Thread Scoped" }),
    });
    assert.equal(createRes.status, 201);
    const createdThread = (await createRes.json()) as ThreadRecord;

    const mainRunRes = await fetch(`${runtime.baseUrl}/api/chat/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionKey: "main",
        message: "main-message",
        idempotencyKey: "thread_snapshot_main_1",
      }),
    });
    assert.equal(mainRunRes.status, 202);
    const mainAccepted = (await mainRunRes.json()) as ChatAccepted;

    const scopedRunRes = await fetch(`${runtime.baseUrl}/api/chat/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionKey: createdThread.threadId,
        message: "thread-message",
        idempotencyKey: "thread_snapshot_scoped_1",
      }),
    });
    assert.equal(scopedRunRes.status, 202);
    const scopedAccepted = (await scopedRunRes.json()) as ChatAccepted;

    const mainStream = await openSsePath(
      runtime.baseUrl,
      `/api/chat/runs/${encodeURIComponent(mainAccepted.runId)}/stream?seq=0`
    );
    t.after(() => {
      mainStream.close();
    });
    await mainStream.waitFor(
      (event) =>
        event.event === "chat" &&
        event.data.runId === mainAccepted.runId &&
        event.data.state === "final"
    );

    const scopedStream = await openSsePath(
      runtime.baseUrl,
      `/api/chat/runs/${encodeURIComponent(scopedAccepted.runId)}/stream?seq=0`
    );
    t.after(() => {
      scopedStream.close();
    });
    await scopedStream.waitFor(
      (event) =>
        event.event === "chat" &&
        event.data.runId === scopedAccepted.runId &&
        event.data.state === "final"
    );

    const scopedSnapshotRes = await fetch(
      `${runtime.baseUrl}/api/threads/${encodeURIComponent(createdThread.threadId)}/snapshot`
    );
    assert.equal(scopedSnapshotRes.status, 200);
    const scopedSnapshot = (await scopedSnapshotRes.json()) as ThreadSnapshotResponse;
    assert.equal(scopedSnapshot.thread.threadId, createdThread.threadId);
    assert.equal(
      scopedSnapshot.runs.some((run) => run.runId === scopedAccepted.runId),
      true
    );
    assert.equal(
      scopedSnapshot.runs.some((run) => run.runId === mainAccepted.runId),
      false
    );
    assert.equal((scopedSnapshot.toolEventsByRun[scopedAccepted.runId] ?? []).length >= 1, true);

    const mainSnapshotRes = await fetch(`${runtime.baseUrl}/api/threads/main/snapshot`);
    assert.equal(mainSnapshotRes.status, 200);
    const mainSnapshot = (await mainSnapshotRes.json()) as ThreadSnapshotResponse;
    assert.equal(mainSnapshot.thread.threadId, "main");
    assert.equal(
      mainSnapshot.runs.some((run) => run.runId === mainAccepted.runId),
      true
    );
    assert.equal(
      mainSnapshot.runs.some((run) => run.runId === scopedAccepted.runId),
      false
    );
  }
);

test(
  "POST /api/chat/abort returns 404 for unknown active run",
  DEFAULT_TEST_TIMEOUT_SECONDS,
  async (t) => {
    const runtime = await startControlPlane();
    t.after(async () => {
      await stopControlPlane(runtime.child);
    });

    const res = await fetch(`${runtime.baseUrl}/api/chat/abort`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionKey: "main" }),
    });
    assert.equal(res.status, 404);
  }
);

test(
  "POST /api/chat/abort cancels active run and returns aborted stream event",
  DEFAULT_TEST_TIMEOUT_SECONDS,
  async (t) => {
    const runtime = await startControlPlane({
      env: {
        ADJUTANT_TEST_MOCK_RUNNER: "1",
        ADJUTANT_TEST_MOCK_DELTA: "abort-delta",
        ADJUTANT_TEST_MOCK_TEXT: "abort-final",
        ADJUTANT_TEST_MOCK_DELAY_MS: "4000",
      },
    });
    t.after(async () => {
      await stopControlPlane(runtime.child);
    });

    const commandRes = await fetch(`${runtime.baseUrl}/api/chat/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionKey: "main",
        message: "abort-message",
        idempotencyKey: "chat_abort_1",
      }),
    });
    assert.equal(commandRes.status, 202);
    const accepted = (await commandRes.json()) as ChatAccepted;

    const wrongSessionAbortRes = await fetch(`${runtime.baseUrl}/api/chat/abort`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionKey: "secondary",
        runId: accepted.runId,
      }),
    });
    assert.equal(wrongSessionAbortRes.status, 404);

    const abortRes = await fetch(`${runtime.baseUrl}/api/chat/abort`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionKey: "main",
        runId: accepted.runId,
      }),
    });
    assert.equal(abortRes.status, 200);

    const stream = await openSsePath(
      runtime.baseUrl,
      `/api/chat/runs/${encodeURIComponent(accepted.runId)}/stream?seq=0`
    );
    t.after(() => {
      stream.close();
    });
    const aborted = await stream.waitFor(
      (event) =>
        event.event === "chat" &&
        event.data.runId === accepted.runId &&
        event.data.state === "aborted"
    );
    assert.equal(aborted.data.sessionKey, "main");

    const snapshotRes = await fetch(`${runtime.baseUrl}/api/snapshot`);
    assert.equal(snapshotRes.status, 200);
    const snapshot = (await snapshotRes.json()) as SnapshotResponse;
    const run = snapshot.runs.find((entry) => entry.runId === accepted.runId);
    assert.equal(run?.status, "cancelled");

    const abortAgainRes = await fetch(`${runtime.baseUrl}/api/chat/abort`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionKey: "main",
        runId: accepted.runId,
      }),
    });
    assert.equal(abortAgainRes.status, 404);
  }
);

test(
  "tool_call updates are reflected in SSE and snapshot history",
  DEFAULT_TEST_TIMEOUT_SECONDS,
  async (t) => {
    const runtime = await startControlPlane({
      env: {
        ADJUTANT_TEST_FAKE_TOOL_CALLS: "1",
      },
    });
    t.after(async () => {
      await stopControlPlane(runtime.child);
    });

    const sse = await openSse(runtime.baseUrl);
    t.after(() => {
      sse.close();
    });

    const commandRes = await fetch(`${runtime.baseUrl}/api/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionKey: "main", message: "hello-tool-history" }),
    });
    assert.equal(commandRes.status, 202);
    const accepted = (await commandRes.json()) as CommandAccepted;

    const chatSse = await openSsePath(
      runtime.baseUrl,
      `/api/chat/runs/${encodeURIComponent(accepted.runId)}/stream?seq=0`
    );
    t.after(() => {
      chatSse.close();
    });

    const toolStart = await sse.waitFor(
      (event) =>
        event.event === "run/update" &&
        event.data.runId === accepted.runId &&
        typeof event.data.update === "object" &&
        event.data.update !== null &&
        (event.data.update as Record<string, unknown>).sessionUpdate === "tool_call"
    );
    const toolStartPayload = toolStart.data.update as Record<string, unknown>;
    assert.equal(toolStartPayload.toolCallId, "fake_call_1");

    await sse.waitFor(
      (event) =>
        event.event === "run/update" &&
        event.data.runId === accepted.runId &&
        typeof event.data.update === "object" &&
        event.data.update !== null &&
        (event.data.update as Record<string, unknown>).sessionUpdate === "tool_call_update" &&
        (event.data.update as Record<string, unknown>).toolCallId === "fake_call_1"
    );

    const chatToolStarted = (await chatSse.waitFor(
      (event) =>
        event.event === "chat" &&
        (event.data as ChatStreamEvent).runId === accepted.runId &&
        (event.data as ChatStreamEvent).toolCallId === "fake_call_1" &&
        (event.data as ChatStreamEvent).toolStatus === "started"
    )) as { event: string; data: ChatStreamEvent };
    assert.deepEqual(chatToolStarted.data.toolInput, { prompt: "hello-tool-history" });

    const chatToolCompleted = (await chatSse.waitFor(
      (event) =>
        event.event === "chat" &&
        (event.data as ChatStreamEvent).runId === accepted.runId &&
        (event.data as ChatStreamEvent).toolCallId === "fake_call_1" &&
        (event.data as ChatStreamEvent).toolStatus === "completed"
    )) as { event: string; data: ChatStreamEvent };
    assert.deepEqual(chatToolCompleted.data.toolOutput, { ok: true });

    await sse.waitFor(
      (event) => event.event === "run/completed" && event.data.runId === accepted.runId
    );

    const snapshotRes = await fetch(`${runtime.baseUrl}/api/snapshot`);
    assert.equal(snapshotRes.status, 200);
    const snapshot = (await snapshotRes.json()) as SnapshotResponse;
    const history = snapshot.toolEventsByRun[accepted.runId] ?? [];
    assert.equal(history.length >= 1, true);
    assert.equal(history[0]?.toolCallId, "fake_call_1");
    assert.equal(history[0]?.status, "completed");
    assert.deepEqual(history[0]?.rawInput, { prompt: "hello-tool-history" });
    assert.deepEqual(history[0]?.rawOutput, { ok: true });

    // reload simulation: initial hydration via snapshot can restore persisted in-memory history
    const snapshotResReload = await fetch(`${runtime.baseUrl}/api/snapshot`);
    assert.equal(snapshotResReload.status, 200);
    const snapshotReload = (await snapshotResReload.json()) as SnapshotResponse;
    const historyReload = snapshotReload.toolEventsByRun[accepted.runId] ?? [];
    assert.equal(historyReload.length, history.length);
    assert.equal(historyReload[0]?.toolCallId, "fake_call_1");
  }
);

test(
  "mock runner integration emits chunk and normalized stopReason",
  DEFAULT_TEST_TIMEOUT_SECONDS,
  async (t) => {
    const runtime = await startControlPlane({
      env: {
        ADJUTANT_TEST_MOCK_RUNNER: "1",
        ADJUTANT_TEST_MOCK_DELTA: "mock-stream-chunk",
        ADJUTANT_TEST_MOCK_TEXT: "mock-runner-text",
        ADJUTANT_TEST_MOCK_STOP_REASON: "length",
      },
    });
    t.after(async () => {
      await stopControlPlane(runtime.child);
    });

    const sse = await openSse(runtime.baseUrl);
    t.after(() => {
      sse.close();
    });

    const commandRes = await fetch(`${runtime.baseUrl}/api/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionKey: "main", message: "hello-mock-runner" }),
    });
    assert.equal(commandRes.status, 202);
    const accepted = (await commandRes.json()) as CommandAccepted;

    const updateEvent = await sse.waitFor(
      (event) =>
        event.event === "run/update" &&
        event.data.runId === accepted.runId &&
        typeof event.data.update === "object" &&
        event.data.update !== null &&
        (event.data.update as Record<string, unknown>).sessionUpdate === "agent_message_chunk"
    );
    const content = (updateEvent.data.update as Record<string, unknown>).content as
      | Record<string, unknown>
      | undefined;
    assert.equal(content?.text, "mock-stream-chunk");

    const completedEvent = await sse.waitFor(
      (event) => event.event === "run/completed" && event.data.runId === accepted.runId
    );
    assert.equal(completedEvent.data.stopReason, "max_tokens");
    assert.equal(completedEvent.data.text, "mock-runner-text");
  }
);

test(
  "session/load recovery reuses sessionId after process restart and tool history is retrievable",
  DEFAULT_TEST_TIMEOUT_SECONDS,
  async (t) => {
    const stateDir = await mkdtemp(join(tmpdir(), "adjutant-session-load-"));
    t.after(async () => {
      await rm(stateDir, { recursive: true, force: true });
    });

    const env = {
      ADJUTANT_STATE_DIR: stateDir,
      ACP_ENABLE_LOAD_SESSION: "1",
      ADJUTANT_TEST_FAKE_TOOL_CALLS: "1",
    };

    const runtime1 = await startControlPlane({ env });
    const sse1 = await openSse(runtime1.baseUrl);

    const commandRes1 = await fetch(`${runtime1.baseUrl}/api/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionKey: "main", message: "first-run" }),
    });
    assert.equal(commandRes1.status, 202);
    const accepted1 = (await commandRes1.json()) as CommandAccepted;
    await sse1.waitFor(
      (event) => event.event === "run/completed" && event.data.runId === accepted1.runId
    );
    sse1.close();
    await stopControlPlane(runtime1.child);

    const runtime2 = await startControlPlane({ env });
    t.after(async () => {
      await stopControlPlane(runtime2.child);
    });

    const sse2 = await openSse(runtime2.baseUrl);
    t.after(() => {
      sse2.close();
    });

    const commandRes2 = await fetch(`${runtime2.baseUrl}/api/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionKey: "main", message: "second-run" }),
    });
    assert.equal(commandRes2.status, 202);
    const accepted2 = (await commandRes2.json()) as CommandAccepted;
    assert.equal(accepted2.sessionRecoveryMode, "session_load");
    assert.equal(accepted2.sessionRecovered, true);

    await sse2.waitFor(
      (event) => event.event === "run/completed" && event.data.runId === accepted2.runId
    );

    const run1 = parseRunId(accepted1.runId);
    const run2 = parseRunId(accepted2.runId);
    assert.equal(run2.sessionId, run1.sessionId);
    assert.equal(run2.runSequence > run1.runSequence, true);

    const snapshotRes = await fetch(`${runtime2.baseUrl}/api/snapshot`);
    assert.equal(snapshotRes.status, 200);
    const snapshot = (await snapshotRes.json()) as SnapshotResponse;
    const history = snapshot.toolEventsByRun[accepted2.runId] ?? [];
    assert.equal(history.length >= 1, true);
    assert.equal(history[0]?.toolCallId, "fake_call_1");
  }
);

test(
  "session/load recoverable failure falls back to new session and exposes fallback metadata",
  DEFAULT_TEST_TIMEOUT_SECONDS,
  async (t) => {
    const stateDir = await mkdtemp(join(tmpdir(), "adjutant-session-fallback-"));

    const journalPath = join(stateDir, "journal", "control-plane", "session-recovery.jsonl");
    await mkdir(join(stateDir, "journal", "control-plane"), { recursive: true });
    await writeFile(
      journalPath,
      `${JSON.stringify({
        sessionKey: "main",
        sessionId: "sess_missing",
        lastRunId: "session:sess_missing:run:2",
        updatedAt: "2026-03-01T12:00:00.000Z",
      })}\n`,
      "utf8"
    );

    const runtime = await startControlPlane({
      env: {
        ADJUTANT_STATE_DIR: stateDir,
        ACP_ENABLE_LOAD_SESSION: "1",
      },
    });
    t.after(async () => {
      await stopControlPlane(runtime.child);
    });
    t.after(async () => {
      await rm(stateDir, { recursive: true, force: true });
    });

    const commandRes = await fetch(`${runtime.baseUrl}/api/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionKey: "main", message: "fallback-check" }),
    });
    assert.equal(commandRes.status, 202);
    const accepted = (await commandRes.json()) as CommandAccepted;
    assert.equal(accepted.sessionRecoveryMode, "fallback_new_session");
    assert.equal(accepted.sessionRecovered, false);
    assert.equal(typeof accepted.sessionRecoveryReason, "string");

    const snapshotRes = await fetch(`${runtime.baseUrl}/api/snapshot`);
    assert.equal(snapshotRes.status, 200);
    const snapshot = (await snapshotRes.json()) as SnapshotResponse;
    const run = snapshot.runs.find((entry) => entry.runId === accepted.runId);
    assert.equal(run?.sessionRecoveryMode, "fallback_new_session");
  }
);

test(
  "agent audit logs run/tool events and run audit API returns summary",
  DEFAULT_TEST_TIMEOUT_SECONDS,
  async (t) => {
    const stateDir = await mkdtemp(join(tmpdir(), "adjutant-agent-audit-"));
    t.after(async () => {
      await rm(stateDir, { recursive: true, force: true });
    });

    const runtime = await startControlPlane({
      env: {
        ADJUTANT_STATE_DIR: stateDir,
        ADJUTANT_TEST_FAKE_TOOL_CALLS: "1",
        ADJUTANT_AGENT_AUDIT_LOG_ENABLED: "1",
        ADJUTANT_MARKDOWN_SUMMARY_BATCH_ENABLED: "1",
        ADJUTANT_PHASE_B_ROLLOUT_SCOPE: "main",
      },
    });
    t.after(async () => {
      await stopControlPlane(runtime.child);
    });

    const sse = await openSse(runtime.baseUrl);
    t.after(() => {
      sse.close();
    });

    const commandRes = await fetch(`${runtime.baseUrl}/api/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionKey: "main", message: "hello-audit" }),
    });
    assert.equal(commandRes.status, 202);
    const accepted = (await commandRes.json()) as CommandAccepted;

    await sse.waitFor(
      (event) => event.event === "run/completed" && event.data.runId === accepted.runId
    );

    let audit: RunAuditResponse | undefined;
    const startedAt = Date.now();
    while (true) {
      const auditRes = await fetch(
        `${runtime.baseUrl}/api/chat/runs/${encodeURIComponent(accepted.runId)}/audit`
      );
      assert.equal(auditRes.status, 200);
      const candidate = (await auditRes.json()) as RunAuditResponse;
      if ((candidate.summaryBatches ?? []).length >= 1) {
        audit = candidate;
        break;
      }
      if (Date.now() - startedAt >= 8_000) {
        audit = candidate;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    if (audit === undefined) {
      throw new Error("missing run audit summary");
    }
    assert.equal(audit.runId, accepted.runId);
    assert.equal(audit.runEnded, true);
    assert.equal(audit.runStatus, "ok");
    assert.equal(audit.tools.length >= 1, true);
    assert.equal(audit.tools[0]?.toolCallId, "fake_call_1");
    const summaryBatches = audit.summaryBatches ?? [];
    if (summaryBatches.length > 0) {
      assert.equal(
        summaryBatches.some((entry) => entry.status === "ok" || entry.status === "error"),
        true
      );
    }

    const auditLogPath = join(stateDir, "audit", "agent-audit.ndjson");
    const rawLog = await readFile(auditLogPath, "utf8");
    assert.equal(rawLog.includes('"type":"run.start"'), true);
    assert.equal(rawLog.includes('"type":"tool.start"'), true);
    assert.equal(rawLog.includes('"type":"run.end"'), true);
  }
);

test(
  "existing API endpoints remain compatible after tool I/O extension",
  DEFAULT_TEST_TIMEOUT_SECONDS,
  async (t) => {
    const runtime = await startControlPlane();
    t.after(async () => {
      await stopControlPlane(runtime.child);
    });

    const sse = await openSse(runtime.baseUrl);
    t.after(() => {
      sse.close();
    });

    const commandRes = await fetch(`${runtime.baseUrl}/api/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionKey: "main", message: "compat-command" }),
    });
    assert.equal(commandRes.status, 202);
    const commandAccepted = (await commandRes.json()) as CommandAccepted;
    assert.equal(typeof commandAccepted.runId, "string");
    assert.ok(commandAccepted.runId.length > 0);

    await sse.waitFor(
      (event) => event.event === "run/accepted" && event.data.runId === commandAccepted.runId
    );
    await sse.waitFor(
      (event) => event.event === "run/completed" && event.data.runId === commandAccepted.runId
    );

    const chatRes = await fetch(`${runtime.baseUrl}/api/chat/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionKey: "main",
        message: "compat-chat",
        idempotencyKey: "compat_chat_1",
      }),
    });
    assert.equal(chatRes.status, 202);
    const chatAccepted = (await chatRes.json()) as ChatAccepted;
    assert.equal(typeof chatAccepted.runId, "string");
    assert.ok(chatAccepted.runId.length > 0);

    const chatSse = await openSsePath(
      runtime.baseUrl,
      `/api/chat/runs/${encodeURIComponent(chatAccepted.runId)}/stream?seq=0`
    );
    t.after(() => {
      chatSse.close();
    });

    await chatSse.waitFor(
      (event) =>
        event.event === "chat" &&
        event.data.runId === chatAccepted.runId &&
        event.data.state === "final"
    );

    const historyRes = await fetch(`${runtime.baseUrl}/api/chat/history?sessionKey=main`);
    assert.equal(historyRes.status, 200);
    const history = (await historyRes.json()) as ChatHistoryResponse;
    assert.equal(Array.isArray(history.messages), true);
    assert.equal(history.messages.length >= 2, true);
  }
);
