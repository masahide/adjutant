import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import type { DeliverCompletedNotification } from "../../../../src/contracts/process-rpc/method-types.js";
import { DeliverSupervisor } from "../../../../src/control-plane/process-rpc/deliver-supervisor.js";

const TEST_TIMEOUT_MS = 20_000;

const nodeTest = (name: string, fn: (t: TestContext) => Promise<void> | void): void => {
  test(name, { timeout: TEST_TIMEOUT_MS }, fn);
};

async function waitFor(predicate: () => boolean, timeoutMs = 1000, intervalMs = 10): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("WAIT_FOR_TIMEOUT");
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

nodeTest("DeliverSupervisor: enqueue accepted と deliver/completed 通知を受信できる", async (t) => {
  const completions: DeliverCompletedNotification[] = [];
  const supervisor = new DeliverSupervisor({
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
      completions.push(notification);
    },
  });

  await supervisor.start();
  t.after(async () => {
    await supervisor.stop();
  });

  const accepted = await supervisor.enqueue({
    messageId: "msg_deliver_supervisor_1",
    dedupeKey: "deliver:msg_deliver_supervisor_1",
    target: "slack",
    payload: {
      text: "done",
    },
    attempt: 1,
    maxAttempts: 3,
  });

  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.messageId, "msg_deliver_supervisor_1");

  await waitFor(() => completions.length >= 1, 2000);
  assert.equal(completions[0]?.messageId, "msg_deliver_supervisor_1");
  assert.equal(completions[0]?.status, "completed");
});

nodeTest("DeliverSupervisor: deliver プロセスクラッシュ時に再起動する", async (t) => {
  const logs: Array<Record<string, unknown>> = [];
  const supervisor = new DeliverSupervisor({
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 10_000)"],
    cwd: process.cwd(),
    maxRestarts: 1,
    restartDelayMs: 20,
    onLog: (entry) => {
      logs.push(entry);
    },
  });

  await supervisor.start();
  t.after(async () => {
    await supervisor.stop();
  });

  supervisor.killChildForTest();
  await new Promise((resolve) => setTimeout(resolve, 200));

  assert.equal(supervisor.getRestartCount() >= 1, true);
  assert.equal(
    logs.some((entry) => entry.code === "DELIVER_CRASHED"),
    true
  );
});

nodeTest("DeliverSupervisor: enqueue timeout 時に DELIVER_RPC_TIMEOUT を記録する", async (t) => {
  const logs: Array<Record<string, unknown>> = [];
  const supervisor = new DeliverSupervisor({
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 10_000)"],
    cwd: process.cwd(),
    requestTimeoutMs: 40,
    maxRestarts: 0,
    onLog: (entry) => {
      logs.push(entry);
    },
  });

  await supervisor.start();
  t.after(async () => {
    await supervisor.stop();
  });

  await assert.rejects(
    () =>
      supervisor.enqueue({
        messageId: "msg_deliver_supervisor_2",
        dedupeKey: "deliver:msg_deliver_supervisor_2",
        target: "slack",
        payload: {},
        attempt: 1,
        maxAttempts: 3,
      }),
    /DELIVER_TIMEOUT/
  );

  assert.equal(
    logs.some((entry) => entry.code === "DELIVER_RPC_TIMEOUT"),
    true
  );
});
