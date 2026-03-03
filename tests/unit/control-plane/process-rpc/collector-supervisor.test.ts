import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { CollectorIngestHandler } from "../../../../src/control-plane/process-rpc/ingest-handler.js";
import { ProcessRpcServer } from "../../../../src/control-plane/process-rpc/server.js";
import { CollectorSupervisor } from "../../../../src/control-plane/process-rpc/collector-supervisor.js";

const TEST_TIMEOUT_MS = 20_000;

const nodeTest = (name: string, fn: (t: TestContext) => Promise<void> | void): void => {
  test(name, { timeout: TEST_TIMEOUT_MS }, fn);
};

function createProcessRpcServer(onAcceptDelayMs = 0): ProcessRpcServer {
  return new ProcessRpcServer({
    ingestHandler: new CollectorIngestHandler({
      onAccept:
        onAcceptDelayMs > 0
          ? async () => {
              await new Promise((resolve) => setTimeout(resolve, onAcceptDelayMs));
            }
          : undefined,
    }),
  });
}

nodeTest("CollectorSupervisor: collector クラッシュ時に再起動する", async (t) => {
  const logs: Array<Record<string, unknown>> = [];
  const supervisor = new CollectorSupervisor({
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 10_000)"],
    cwd: process.cwd(),
    processRpcServer: createProcessRpcServer(),
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
    logs.some((entry) => entry.code === "COLLECTOR_CRASHED"),
    true
  );
});

nodeTest(
  "CollectorSupervisor: handler timeout 時に COLLECTOR_RPC_TIMEOUT を記録する",
  async (t) => {
    const logs: Array<Record<string, unknown>> = [];
    const script = `
const request = {
  jsonrpc: "2.0",
  id: "ing_timeout",
  method: "collector/ingest",
  params: {
    messageId: "msg_timeout_1",
    dedupeKey: "slack:C123@1730000000.123",
    source: "slack",
    occurredAt: "2026-03-03T12:00:00.000Z",
    payload: {
      schema: "adjutant.event.v1.1",
      uid: "slack:C123@1730000000.123",
      source: "slack",
      kind: "post",
      ts: "2026-03-03T12:00:00.000Z",
      detail: {
        slack: {
          channel_id: "C123",
          message_ts: "1730000000.123",
          text: "hello"
        }
      }
    }
  }
};
process.stdout.write(JSON.stringify(request) + "\\n");
setInterval(() => {}, 10_000);
`;

    const supervisor = new CollectorSupervisor({
      command: process.execPath,
      args: ["-e", script],
      cwd: process.cwd(),
      processRpcServer: createProcessRpcServer(120),
      requestTimeoutMs: 30,
      maxRestarts: 0,
      onLog: (entry) => {
        logs.push(entry);
      },
    });

    await supervisor.start();
    t.after(async () => {
      await supervisor.stop();
    });

    await new Promise((resolve) => setTimeout(resolve, 160));
    assert.equal(
      logs.some((entry) => entry.code === "COLLECTOR_RPC_TIMEOUT"),
      true
    );
  }
);
