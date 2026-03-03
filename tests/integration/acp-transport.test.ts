import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import nodeTest, { type TestContext } from "node:test";

interface JsonRpcEnvelope {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

const TEST_TIMEOUT_MS = 30_000;

const test = (name: string, fn: (t: TestContext) => Promise<void> | void): void => {
  nodeTest(name, { timeout: TEST_TIMEOUT_MS }, fn);
};

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

test("ACP stdio transport integrates initialize/session-new/session-prompt", async (t) => {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src/agent-worker-acp/stdio-server.ts"],
    {
      cwd: process.cwd(),
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

  const send = (envelope: JsonRpcEnvelope): void => {
    child.stdin.write(`${JSON.stringify(envelope)}\n`);
  };

  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: 1 },
  });

  const initialized = await waitForCondition(
    (entry) => entry.id === 1 && entry.result !== undefined,
    envelopes
  );
  assert.equal(initialized.result?.protocolVersion, 1);

  send({
    jsonrpc: "2.0",
    id: 2,
    method: "session/new",
    params: {},
  });

  const created = await waitForCondition(
    (entry) => entry.id === 2 && entry.result !== undefined,
    envelopes
  );
  const sessionId = created.result?.sessionId;
  assert.equal(typeof sessionId, "string");

  send({
    jsonrpc: "2.0",
    id: 3,
    method: "session/prompt",
    params: { sessionId, prompt: "hello" },
  });

  const update = await waitForCondition((entry) => entry.method === "session/update", envelopes);
  assert.equal(update.params?.sessionId, sessionId);
  const updatePayload = update.params?.update as Record<string, unknown> | undefined;
  assert.equal(updatePayload?.sessionUpdate, "agent_message_chunk");

  const promptResult = await waitForCondition(
    (entry) => entry.id === 3 && entry.result !== undefined,
    envelopes
  );
  assert.equal(promptResult.result?.stopReason, "end_turn");
  assert.equal(promptResult.result?.text, "hello");
});

test("ACP stdio transport responds to session/cancel requests", async (t) => {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src/agent-worker-acp/stdio-server.ts"],
    {
      cwd: process.cwd(),
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

  const send = (envelope: JsonRpcEnvelope): void => {
    child.stdin.write(`${JSON.stringify(envelope)}\n`);
  };

  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: 1 },
  });
  await waitForCondition((entry) => entry.id === 1 && entry.result !== undefined, envelopes);

  send({
    jsonrpc: "2.0",
    id: 2,
    method: "session/new",
    params: {},
  });
  const created = await waitForCondition(
    (entry) => entry.id === 2 && entry.result !== undefined,
    envelopes
  );
  const sessionId = created.result?.sessionId;
  assert.equal(typeof sessionId, "string");

  send({
    jsonrpc: "2.0",
    id: 3,
    method: "session/cancel",
    params: { sessionId },
  });
  const cancelResult = await waitForCondition(
    (entry) => entry.id === 3 && entry.result !== undefined,
    envelopes
  );
  assert.equal(typeof cancelResult.result?.cancelled, "boolean");
});
