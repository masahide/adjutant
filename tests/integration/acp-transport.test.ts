import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import test from "node:test";

interface JsonRpcEnvelope {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

interface WorkerClient {
  child: ChildProcessWithoutNullStreams;
  envelopes: JsonRpcEnvelope[];
  send: (envelope: JsonRpcEnvelope) => void;
}

function waitForCondition(
  predicate: (envelope: JsonRpcEnvelope) => boolean,
  envelopes: JsonRpcEnvelope[],
  timeoutMs = 2000
): Promise<JsonRpcEnvelope> {
  const found = envelopes.find(predicate);
  if (found !== undefined) {
    return Promise.resolve(found);
  }

  return new Promise((resolve, reject) => {
    const start = Date.now();

    const timer = setInterval(() => {
      const candidate = envelopes.find(predicate);
      if (candidate !== undefined) {
        clearInterval(timer);
        resolve(candidate);
        return;
      }

      if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        reject(new Error("timeout"));
      }
    }, 10);
  });
}

function startWorker(t: test.TestContext, env: NodeJS.ProcessEnv = {}): WorkerClient {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src/agent-worker-acp/stdio-server.ts"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    }
  );

  t.after(() => {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  });

  const envelopes: JsonRpcEnvelope[] = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    chunk
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .forEach((line) => {
        envelopes.push(JSON.parse(line) as JsonRpcEnvelope);
      });
  });

  return {
    child,
    envelopes,
    send: (envelope: JsonRpcEnvelope) => {
      child.stdin.write(`${JSON.stringify(envelope)}\n`);
    },
  };
}

async function initialize(client: WorkerClient): Promise<void> {
  client.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: 1 },
  });
  await waitForCondition((entry) => entry.id === 1 && entry.result !== undefined, client.envelopes);
}

async function createSession(client: WorkerClient, id: number): Promise<string> {
  client.send({
    jsonrpc: "2.0",
    id,
    method: "session/new",
    params: {},
  });
  const created = await waitForCondition(
    (entry) => entry.id === id && entry.result !== undefined,
    client.envelopes
  );
  const sessionId = created.result?.sessionId;
  if (typeof sessionId !== "string") {
    throw new Error("sessionId is required");
  }
  return sessionId;
}

test("ACP stdio transport integrates initialize/session-new/session-prompt", async (t) => {
  const client = startWorker(t);
  await initialize(client);
  const sessionId = await createSession(client, 2);

  client.send({
    jsonrpc: "2.0",
    id: 3,
    method: "session/prompt",
    params: { sessionId, prompt: "hello" },
  });

  const update = await waitForCondition(
    (entry) => entry.method === "session/update",
    client.envelopes
  );
  assert.equal(update.params?.sessionId, sessionId);
  const updatePayload = update.params?.update as Record<string, unknown> | undefined;
  assert.equal(updatePayload?.sessionUpdate, "agent_message_chunk");

  const promptResult = await waitForCondition(
    (entry) => entry.id === 3 && entry.result !== undefined,
    client.envelopes
  );
  assert.equal(promptResult.result?.stopReason, "end_turn");
  assert.equal(promptResult.result?.text, "hello");
});

test("ACP stdio transport responds to session/cancel requests", async (t) => {
  const client = startWorker(t);
  await initialize(client);
  const sessionId = await createSession(client, 2);

  client.send({
    jsonrpc: "2.0",
    id: 3,
    method: "session/cancel",
    params: { sessionId },
  });
  const cancelResult = await waitForCondition(
    (entry) => entry.id === 3 && entry.result !== undefined,
    client.envelopes
  );
  assert.equal(typeof cancelResult.result?.cancelled, "boolean");
});

test("ACP stdio transport rejects duplicate in-flight prompt on same session", async (t) => {
  const client = startWorker(t, {
    ADJUTANT_TEST_MOCK_RUNNER: "1",
    ADJUTANT_TEST_MOCK_DELAY_MS: "300",
  });
  await initialize(client);
  const sessionId = await createSession(client, 2);

  client.send({
    jsonrpc: "2.0",
    id: 3,
    method: "session/prompt",
    params: { sessionId, prompt: "first" },
  });
  client.send({
    jsonrpc: "2.0",
    id: 4,
    method: "session/prompt",
    params: { sessionId, prompt: "second" },
  });

  const busyError = await waitForCondition(
    (entry) => entry.id === 4 && entry.error !== undefined,
    client.envelopes
  );
  assert.equal(busyError.error?.message.includes("SESSION_BUSY"), true);

  const firstResult = await waitForCondition(
    (entry) => entry.id === 3 && entry.result !== undefined,
    client.envelopes,
    4000
  );
  assert.equal(firstResult.result?.stopReason, "end_turn");
});

test("ACP stdio transport can run two sessions concurrently and cancel one side", async (t) => {
  const client = startWorker(t, {
    ADJUTANT_TEST_MOCK_RUNNER: "1",
    ADJUTANT_TEST_MOCK_DELAY_MS: "500",
  });
  await initialize(client);
  const sessionA = await createSession(client, 2);
  const sessionB = await createSession(client, 3);

  client.send({
    jsonrpc: "2.0",
    id: 4,
    method: "session/prompt",
    params: { sessionId: sessionA, prompt: "prompt A" },
  });
  client.send({
    jsonrpc: "2.0",
    id: 5,
    method: "session/prompt",
    params: { sessionId: sessionB, prompt: "prompt B" },
  });

  await waitForCondition(
    (entry) => entry.method === "session/update" && entry.params?.sessionId === sessionA,
    client.envelopes
  );
  await waitForCondition(
    (entry) => entry.method === "session/update" && entry.params?.sessionId === sessionB,
    client.envelopes
  );

  client.send({
    jsonrpc: "2.0",
    id: 6,
    method: "session/cancel",
    params: { sessionId: sessionA },
  });

  const cancelAck = await waitForCondition(
    (entry) => entry.id === 6 && entry.result !== undefined,
    client.envelopes
  );
  assert.equal(cancelAck.result?.cancelled, true);

  const resultA = await waitForCondition(
    (entry) => entry.id === 4 && entry.result !== undefined,
    client.envelopes,
    4000
  );
  const resultB = await waitForCondition(
    (entry) => entry.id === 5 && entry.result !== undefined,
    client.envelopes,
    4000
  );

  assert.equal(resultA.result?.stopReason, "cancelled");
  assert.equal(resultB.result?.stopReason, "end_turn");
});

test("ACP stdio transport returns INVALID_RECORD for unknown session", async (t) => {
  const client = startWorker(t);
  await initialize(client);

  client.send({
    jsonrpc: "2.0",
    id: 2,
    method: "session/prompt",
    params: { sessionId: "sess_unknown", prompt: "hello" },
  });
  const promptError = await waitForCondition(
    (entry) => entry.id === 2 && entry.error !== undefined,
    client.envelopes
  );
  assert.equal(promptError.error?.message.includes("INVALID_RECORD"), true);

  client.send({
    jsonrpc: "2.0",
    id: 3,
    method: "session/cancel",
    params: { sessionId: "sess_unknown" },
  });
  const cancelError = await waitForCondition(
    (entry) => entry.id === 3 && entry.error !== undefined,
    client.envelopes
  );
  assert.equal(cancelError.error?.message.includes("INVALID_RECORD"), true);
});
