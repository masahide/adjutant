import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

type CommandAccepted = {
  messageId: string;
  status: "accepted";
  acceptedAt: string;
  runId: string;
  sessionRecovered?: boolean;
  sessionRecoveryMode?: string;
  sessionRecoveryReason?: string;
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
    }>
  >;
  pendingPermissions: unknown[];
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

async function waitForHttpReady(baseUrl: string, timeoutMs = 10000): Promise<void> {
  const startedAt = Date.now();
  // eslint-disable-next-line no-constant-condition
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

  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      ADJUTANT_CONTROL_PLANE_HOST: "127.0.0.1",
      ADJUTANT_CONTROL_PLANE_PORT: String(port),
      ...(options?.env ?? {}),
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

async function openSse(baseUrl: string): Promise<SseConnection> {
  const response = await fetch(`${baseUrl}/api/events/stream`);
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

test("control-plane startup launches HTTP listen and worker path", async (t) => {
  const runtime = await startControlPlane();
  t.after(async () => {
    await stopControlPlane(runtime.child);
  });

  const rootRes = await fetch(`${runtime.baseUrl}/`);
  assert.equal(rootRes.status, 200);
  const html = await rootRes.text();
  assert.equal(html.includes("Adjutant Web UI (co-located)"), true);
  assert.equal(html.includes('id="command-form"'), true);

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
});

test("POST /api/commands emits accepted -> update -> completed over SSE", async (t) => {
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
});

test("POST /api/commands dedupes same idempotencyKey and rejects conflicting payload", async (t) => {
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
  // eslint-disable-next-line no-constant-condition
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
});

test("tool_call updates are reflected in SSE and snapshot history", async (t) => {
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

  // reload simulation: initial hydration via snapshot can restore persisted in-memory history
  const snapshotResReload = await fetch(`${runtime.baseUrl}/api/snapshot`);
  assert.equal(snapshotResReload.status, 200);
  const snapshotReload = (await snapshotResReload.json()) as SnapshotResponse;
  const historyReload = snapshotReload.toolEventsByRun[accepted.runId] ?? [];
  assert.equal(historyReload.length, history.length);
  assert.equal(historyReload[0]?.toolCallId, "fake_call_1");
});

test("mock runner integration emits chunk and normalized stopReason", async (t) => {
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
});

test("session/load recovery reuses sessionId after process restart and tool history is retrievable", async (t) => {
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
});

test("session/load recoverable failure falls back to new session and exposes fallback metadata", async (t) => {
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
});

test("agent audit logs run/tool events and run audit API returns summary", async (t) => {
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

  const auditRes = await fetch(
    `${runtime.baseUrl}/api/chat/runs/${encodeURIComponent(accepted.runId)}/audit`
  );
  assert.equal(auditRes.status, 200);
  const audit = (await auditRes.json()) as RunAuditResponse;
  assert.equal(audit.runId, accepted.runId);
  assert.equal(audit.runEnded, true);
  assert.equal(audit.runStatus, "ok");
  assert.equal(audit.tools.length >= 1, true);
  assert.equal(audit.tools[0]?.toolCallId, "fake_call_1");
  assert.equal((audit.summaryBatches ?? []).length >= 1, true);

  const auditLogPath = join(stateDir, "audit", "agent-audit.ndjson");
  const rawLog = await readFile(auditLogPath, "utf8");
  assert.equal(rawLog.includes('"type":"run.start"'), true);
  assert.equal(rawLog.includes('"type":"tool.start"'), true);
  assert.equal(rawLog.includes('"type":"run.end"'), true);
});
