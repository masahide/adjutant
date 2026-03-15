import assert from "node:assert/strict";
import nodeTest, { type TestContext } from "node:test";

import type {
  CollectorIngestRequest,
  CollectorIngestResponse,
  DeliverCompletedNotification,
  DeliverEnqueueRequest,
  DeliverEnqueueResponse,
} from "../../src/contracts/process-rpc/method-types.js";
import { WorkerSupervisor } from "../../src/control-plane/acp/worker-supervisor.js";
import { DeliverCompletionStore } from "../../src/control-plane/deliver-completion-store.js";

const TEST_TIMEOUT_MS = 30_000;

const test = (name: string, fn: (t: TestContext) => Promise<void> | void): void => {
  nodeTest(name, { timeout: TEST_TIMEOUT_MS }, fn);
};

function accepted(messageId: string): {
  messageId: string;
  status: "accepted";
  acceptedAt: string;
} {
  return {
    messageId,
    status: "accepted",
    acceptedAt: new Date().toISOString(),
  };
}

test("slack acp e2e: collector accepted -> worker prompt -> deliver accepted -> completed", async (t) => {
  const supervisor = new WorkerSupervisor({
    command: process.execPath,
    args: ["--import", "tsx", "src/agent-worker-acp/stdio-server.ts"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      ADJUTANT_TEST_MOCK_RUNNER: "1",
      ADJUTANT_TEST_MOCK_TEXT: "hello from slack",
      ADJUTANT_TEST_MOCK_DELTA: "hello from slack",
    },
    maxRestarts: 1,
    restartDelayMs: 20,
  });

  await supervisor.start();
  t.after(async () => {
    await supervisor.stop();
  });

  const completionStore = new DeliverCompletionStore();

  const ingestRequest: CollectorIngestRequest = {
    messageId: "msg_e2e_1",
    dedupeKey: "slack:C01:1700000000.001",
    source: "slack",
    payload: {
      schema: "adjutant.event.v1.1",
      uid: "slack:C01@1700000000.001",
      source: "slack",
      kind: "post",
      ts: "2026-02-28T12:00:00.000Z",
      detail: {
        slack: {
          channel_id: "C01",
          message_ts: "1700000000.001",
          text: "hello from slack",
        },
      },
    },
    occurredAt: "2026-02-28T12:00:00.000Z",
  };

  const ingestAccepted: CollectorIngestResponse = accepted(ingestRequest.messageId);
  assert.equal(ingestAccepted.status, "accepted");

  const init = await supervisor.request("initialize", { protocolVersion: 1 });
  assert.equal(init.protocolVersion, 1);

  const session = await supervisor.request("session/new", {});
  const sessionId = session.sessionId;
  assert.equal(typeof sessionId, "string");

  const prompt = await supervisor.request("session/prompt", {
    sessionId,
    prompt: String(
      (ingestRequest.payload.detail as { slack?: { text?: string } }).slack?.text ?? ""
    ),
  });

  const enqueueRequest: DeliverEnqueueRequest = {
    messageId: ingestRequest.messageId,
    dedupeKey: `deliver:${ingestRequest.messageId}`,
    target: "slack",
    payload: {
      text: String(prompt.text ?? ""),
    },
    attempt: 1,
    maxAttempts: 3,
  };

  const enqueueAccepted: DeliverEnqueueResponse = accepted(enqueueRequest.messageId);
  assert.equal(enqueueAccepted.status, "accepted");

  const completion: DeliverCompletedNotification = {
    messageId: enqueueRequest.messageId,
    status: "completed",
    finishedAt: new Date().toISOString(),
  };

  const applied = completionStore.apply(completion);
  assert.equal(applied.final.status, "completed");
});
