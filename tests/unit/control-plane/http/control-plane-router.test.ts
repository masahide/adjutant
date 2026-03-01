import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { PermissionGateway } from "../../../../src/control-plane/acp/permission-gateway.js";
import type { WorkerSupervisor } from "../../../../src/control-plane/acp/worker-supervisor.js";
import { RunLifecycle } from "../../../../src/control-plane/http/run-lifecycle.js";
import { RunEventBuffer } from "../../../../src/control-plane/http/run-event-buffer.js";
import { SseHub } from "../../../../src/control-plane/http/sse-hub.js";
import { ChatHistoryStore } from "../../../../src/control-plane/http/chat-history-store.js";
import { createControlPlaneRequestHandler } from "../../../../src/control-plane/http/control-plane-router.js";

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
        if (error !== undefined) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

test("POST /api/chat/abort keeps best-effort cancellation even when worker cancel request fails", async (t) => {
  const runLifecycle = new RunLifecycle({
    now: () => "2026-03-01T00:00:00.000Z",
    newMessageId: () => "msg_test",
  });
  runLifecycle.sessions().set("main", { sessionId: "sess_abort", runSequence: 0 });
  const session = runLifecycle.sessions().get("main");
  assert.ok(session);
  const accepted = runLifecycle.beginRun("main", session);
  runLifecycle.markRunning(accepted.runId);

  const runEventBuffer = new RunEventBuffer({ retentionMs: 60_000 });
  runEventBuffer.ensureRun(accepted.runId, "main");

  const handler = createControlPlaneRequestHandler({
    sseHub: new SseHub(),
    renderRootPage: () => "<!doctype html><html></html>",
    buildSnapshot: () => ({ runs: [], toolEventsByRun: {}, pendingPermissions: [] }),
    submitPrompt: async () => {
      throw new Error("not used");
    },
    readRunAudit: async () => ({}),
    runLifecycle,
    runEventBuffer,
    chatHistoryStore: new ChatHistoryStore(),
    supervisor: {
      request: async () => {
        throw new Error("WORKER_TIMEOUT: session/cancel");
      },
    } as unknown as WorkerSupervisor,
    permissionGateway: new PermissionGateway({
      emitUiEvent: () => {},
    }),
  });

  const port = await allocatePort();
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve());
  });
  t.after(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  const response = await fetch(`http://127.0.0.1:${port}/api/chat/abort`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionKey: "main",
      runId: accepted.runId,
    }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {});

  const run = runLifecycle.runs().get(accepted.runId);
  assert.equal(run?.status, "cancelled");
  assert.equal(runLifecycle.resolveRunId("sess_abort"), undefined);

  const events = runEventBuffer.replay(accepted.runId, 0);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.state, "aborted");
});
