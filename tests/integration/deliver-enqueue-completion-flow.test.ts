import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nodeTest, { type TestContext } from "node:test";

import type { DeliverEnqueueRequest } from "../../src/contracts/process-rpc/method-types.js";
import { DeliverCompletionStore } from "../../src/control-plane/deliver-completion-store.js";
import { DeliverEnqueueHandler } from "../../src/control-plane/process-rpc/deliver-handler.js";
import { DeliverQueueCoordinator } from "../../src/control-plane/process-rpc/deliver-queue-coordinator.js";
import { DeliverQueueStore } from "../../src/control-plane/process-rpc/deliver-queue-store.js";
import { DeliverSupervisor } from "../../src/control-plane/process-rpc/deliver-supervisor.js";
import { CollectorIngestHandler } from "../../src/control-plane/process-rpc/ingest-handler.js";
import { ProcessRpcServer } from "../../src/control-plane/process-rpc/server.js";

const TEST_TIMEOUT_MS = 30_000;

const test = (name: string, fn: (t: TestContext) => Promise<void> | void): void => {
  nodeTest(name, { timeout: TEST_TIMEOUT_MS }, fn);
};

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
  intervalMs = 10
): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("WAIT_FOR_TIMEOUT");
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

test("deliver enqueue accepted から deliver/completed まで queue/completion が連動する", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "adjutant-deliver-flow-"));
  t.after(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  const queueStore = DeliverQueueStore.fromStateDir(stateDir);
  await queueStore.initialize();

  const completionStore = new DeliverCompletionStore();
  const completionErrors: Error[] = [];
  let deliverSupervisor: DeliverSupervisor | undefined;

  const coordinator = new DeliverQueueCoordinator({
    queueStore,
    completionStore,
    resolveDispatcher: () => deliverSupervisor,
    dispatchTimeoutMs: 1_000,
  });

  const processRpcServer = new ProcessRpcServer({
    ingestHandler: new CollectorIngestHandler(),
    deliverHandler: new DeliverEnqueueHandler({
      onAccept: async (request) => {
        await coordinator.accept(request);
      },
    }),
  });

  deliverSupervisor = new DeliverSupervisor({
    command: process.execPath,
    args: ["--import", "tsx", "src/deliver-slack/stdio-server.ts"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      ADJUTANT_DELIVER_SLACK_AUTO_COMPLETE: "1",
      ADJUTANT_DELIVER_SLACK_COMPLETION_DELAY_MS: "0",
    },
    maxRestarts: 0,
    onCompleted: (notification) => {
      void coordinator.applyCompletion(notification).catch((error) => {
        completionErrors.push(error instanceof Error ? error : new Error(String(error)));
      });
    },
  });
  await deliverSupervisor.start();
  t.after(async () => {
    await deliverSupervisor?.stop();
  });

  const request: DeliverEnqueueRequest = {
    messageId: "msg_deliver_flow_1",
    dedupeKey: "deliver:msg_deliver_flow_1",
    target: "slack",
    payload: {
      text: "done",
    },
    attempt: 1,
    maxAttempts: 3,
  };

  const response = await processRpcServer.handleRequest({
    jsonrpc: "2.0",
    id: "del_1",
    method: "deliver/enqueue",
    params: request,
  });

  assert.equal("result" in response, true);
  if (!("result" in response)) {
    return;
  }
  assert.equal(response.result.status, "accepted");
  assert.equal(response.result.messageId, request.messageId);

  await waitFor(
    () =>
      completionErrors.length > 0 ||
      completionStore.get(request.messageId) !== undefined ||
      queueStore.currentCursor().offset > 0,
    3_000
  );

  assert.deepEqual(completionErrors, []);
  assert.equal(completionStore.get(request.messageId)?.status, "completed");
  assert.deepEqual(queueStore.currentCursor(), { segment: 0, offset: 1 });
});
