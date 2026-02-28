import assert from "node:assert/strict";
import test from "node:test";

import { WorkerSupervisor } from "../../src/control-plane/acp/worker-supervisor.js";

test("worker supervisor handles protocol error, timeout, crash restart recovery", async (t) => {
  const logs: Record<string, unknown>[] = [];

  const runtimeSupervisor = new WorkerSupervisor({
    command: process.execPath,
    args: ["--import", "tsx", "src/agent-worker-acp/stdio-server.ts"],
    cwd: process.cwd(),
    maxRestarts: 2,
    restartDelayMs: 20,
    onLog: (entry) => logs.push(entry),
  });

  const timeoutSupervisor = new WorkerSupervisor({
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 10_000)"],
    cwd: process.cwd(),
    maxRestarts: 0,
  });

  await runtimeSupervisor.start();
  await timeoutSupervisor.start();
  t.after(async () => {
    await runtimeSupervisor.stop();
    await timeoutSupervisor.stop();
  });

  await assert.rejects(async () => {
    await runtimeSupervisor.request("initialize", { protocolVersion: 999 });
  }, /ACP_PROTOCOL_ERROR/);

  await assert.rejects(async () => {
    await timeoutSupervisor.request("initialize", { protocolVersion: 1 }, { timeoutMs: 80 });
  }, /WORKER_TIMEOUT/);

  runtimeSupervisor.killChildForTest();

  await new Promise((resolve) => setTimeout(resolve, 150));

  const initResult = await runtimeSupervisor.request("initialize", { protocolVersion: 1 });
  assert.equal(initResult.protocolVersion, 1);

  assert.equal(runtimeSupervisor.getRestartCount() >= 1, true);
  assert.equal(
    logs.some((entry) => entry.code === "WORKER_CRASHED"),
    true
  );
});
