import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PermissionGateway } from "../../../../src/control-plane/acp/permission-gateway.js";
import type { WorkerSupervisor } from "../../../../src/control-plane/acp/worker-supervisor.js";
import { RunLifecycle } from "../../../../src/control-plane/http/run-lifecycle.js";
import { RunEventBuffer } from "../../../../src/control-plane/http/run-event-buffer.js";
import { SseHub } from "../../../../src/control-plane/http/sse-hub.js";
import { ChatHistoryStore } from "../../../../src/control-plane/http/chat-history-store.js";
import { createControlPlaneRequestHandler } from "../../../../src/control-plane/http/control-plane-router.js";
import { ThreadRepository } from "../../../../src/control-plane/http/thread-repository.js";

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
  const stateDir = await mkdtemp(join(tmpdir(), "adjutant-router-test-"));
  t.after(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });
  const threadRepository = ThreadRepository.fromStateDir(stateDir);
  await threadRepository.initialize();

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
    threadRepository,
    buildThreadSnapshot: () => {
      const thread = threadRepository.getOrVirtual("main");
      if (thread === undefined) {
        return undefined;
      }
      return {
        thread,
        runs: [],
        toolEventsByRun: {},
        pendingPermissions: [],
      };
    },
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

test("POST /api/permissions/resolve resolves pending permission and rejects invalid requests", async (t) => {
  const runLifecycle = new RunLifecycle({
    now: () => "2026-03-01T00:00:00.000Z",
    newMessageId: () => "msg_test",
  });
  const runEventBuffer = new RunEventBuffer({ retentionMs: 60_000 });
  const stateDir = await mkdtemp(join(tmpdir(), "adjutant-router-test-perm-"));
  t.after(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });
  const threadRepository = ThreadRepository.fromStateDir(stateDir);
  await threadRepository.initialize();
  const permissionGateway = new PermissionGateway({
    emitUiEvent: () => {},
  });
  const pending = permissionGateway.requestPermission({
    requestId: "perm_1",
    sessionId: "sess_perm",
    title: "Allow bash command",
  });

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
    threadRepository,
    buildThreadSnapshot: () => {
      const thread = threadRepository.getOrVirtual("main");
      if (thread === undefined) {
        return undefined;
      }
      return {
        thread,
        runs: [],
        toolEventsByRun: {},
        pendingPermissions: [],
      };
    },
    supervisor: {
      request: async () => {
        throw new Error("not used");
      },
    } as unknown as WorkerSupervisor,
    permissionGateway,
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

  const invalidRes = await fetch(`http://127.0.0.1:${port}/api/permissions/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ requestId: "perm_1", outcome: "cancelled" }),
  });
  assert.equal(invalidRes.status, 400);

  const resolveRes = await fetch(`http://127.0.0.1:${port}/api/permissions/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ requestId: "perm_1", outcome: "allow_once" }),
  });
  assert.equal(resolveRes.status, 200);
  assert.deepEqual(await resolveRes.json(), {});
  assert.equal(await pending, "allow_once");

  const missingRes = await fetch(`http://127.0.0.1:${port}/api/permissions/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ requestId: "perm_1", outcome: "allow_once" }),
  });
  assert.equal(missingRes.status, 404);
});

test("POST /api/chat/messages returns 404 when sessionKey is unknown", async (t) => {
  const runLifecycle = new RunLifecycle({
    now: () => "2026-03-01T00:00:00.000Z",
    newMessageId: () => "msg_test",
  });
  const runEventBuffer = new RunEventBuffer({ retentionMs: 60_000 });
  const stateDir = await mkdtemp(join(tmpdir(), "adjutant-router-test-chat-unknown-"));
  t.after(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });
  const threadRepository = ThreadRepository.fromStateDir(stateDir);
  await threadRepository.initialize();

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
    threadRepository,
    buildThreadSnapshot: () => {
      const thread = threadRepository.getOrVirtual("main");
      if (thread === undefined) {
        return undefined;
      }
      return {
        thread,
        runs: [],
        toolEventsByRun: {},
        pendingPermissions: [],
      };
    },
    supervisor: {
      request: async () => {
        throw new Error("not used");
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

  const response = await fetch(`http://127.0.0.1:${port}/api/chat/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionKey: "thr_unknown",
      message: "hello",
      idempotencyKey: "chat_unknown_1",
    }),
  });
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), {
    code: "NOT_FOUND",
    message: "unknown sessionKey: thr_unknown",
  });
});

test("POST /api/threads/:threadId/generate-title returns generated title", async (t) => {
  const runLifecycle = new RunLifecycle({
    now: () => "2026-03-01T00:00:00.000Z",
    newMessageId: () => "msg_test",
  });
  const runEventBuffer = new RunEventBuffer({ retentionMs: 60_000 });
  const stateDir = await mkdtemp(join(tmpdir(), "adjutant-router-test-thread-title-"));
  t.after(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });
  const threadRepository = ThreadRepository.fromStateDir(stateDir);
  await threadRepository.initialize();
  const created = await threadRepository.create({ title: "" });

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
    threadRepository,
    buildThreadSnapshot: () => undefined,
    generateThreadTitle: async () => ({
      title: "Archive UI cleanup",
      model: "gpt-5.4-nano",
      fallback: false,
    }),
    supervisor: {
      request: async () => {
        throw new Error("not used");
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

  const response = await fetch(
    `http://127.0.0.1:${port}/api/threads/${encodeURIComponent(created.threadId)}/generate-title`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: ["Archive 済み thread を safer に戻す導線を設計したい"],
      }),
    }
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    title: "Archive UI cleanup",
    model: "gpt-5.4-nano",
    fallback: false,
  });
});

test("POST /api/commands rejects blank sessionKey", async (t) => {
  const runLifecycle = new RunLifecycle({
    now: () => "2026-03-01T00:00:00.000Z",
    newMessageId: () => "msg_test",
  });
  const runEventBuffer = new RunEventBuffer({ retentionMs: 60_000 });
  const stateDir = await mkdtemp(join(tmpdir(), "adjutant-router-test-command-blank-"));
  t.after(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });
  const threadRepository = ThreadRepository.fromStateDir(stateDir);
  await threadRepository.initialize();

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
    threadRepository,
    buildThreadSnapshot: () => {
      const thread = threadRepository.getOrVirtual("main");
      if (thread === undefined) {
        return undefined;
      }
      return {
        thread,
        runs: [],
        toolEventsByRun: {},
        pendingPermissions: [],
      };
    },
    supervisor: {
      request: async () => {
        throw new Error("not used");
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

  const response = await fetch(`http://127.0.0.1:${port}/api/commands`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionKey: "   ",
      message: "hello",
    }),
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    code: "INVALID_REQUEST",
    message: "sessionKey/message are required",
  });
});

test("heartbeat API: run / last / history が契約どおり応答する", async (t) => {
  const runLifecycle = new RunLifecycle({
    now: () => "2026-03-01T00:00:00.000Z",
    newMessageId: () => "msg_test",
  });
  const runEventBuffer = new RunEventBuffer({ retentionMs: 60_000 });
  const stateDir = await mkdtemp(join(tmpdir(), "adjutant-router-test-heartbeat-"));
  t.after(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });
  const threadRepository = ThreadRepository.fromStateDir(stateDir);
  await threadRepository.initialize();
  const sample = {
    schema: "adjutant.heartbeat.result.v1" as const,
    status: "ran" as const,
    event: {
      status: "sent" as const,
      reason: "stale thread",
    },
    ts: "2026-03-05T00:00:00.000Z",
    runId: "session:s1:run:10",
  };

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
    threadRepository,
    buildThreadSnapshot: () => {
      const thread = threadRepository.getOrVirtual("main");
      if (thread === undefined) {
        return undefined;
      }
      return {
        thread,
        runs: [],
        toolEventsByRun: {},
        pendingPermissions: [],
      };
    },
    supervisor: {
      request: async () => {
        throw new Error("not used");
      },
    } as unknown as WorkerSupervisor,
    permissionGateway: new PermissionGateway({
      emitUiEvent: () => {},
    }),
    runHeartbeat: async () => sample,
    getLastHeartbeat: () => sample,
    listHeartbeatHistory: () => ({
      items: [sample],
      nextCursor: "MQ",
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

  const runRes = await fetch(`http://127.0.0.1:${port}/api/heartbeat/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason: "manual-check" }),
  });
  assert.equal(runRes.status, 200);
  assert.deepEqual(await runRes.json(), sample);

  const lastRes = await fetch(`http://127.0.0.1:${port}/api/heartbeat/last`);
  assert.equal(lastRes.status, 200);
  assert.deepEqual(await lastRes.json(), sample);

  const historyRes = await fetch(
    `http://127.0.0.1:${port}/api/heartbeat/history?limit=10&cursor=MQ`
  );
  assert.equal(historyRes.status, 200);
  assert.deepEqual(await historyRes.json(), {
    items: [sample],
    nextCursor: "MQ",
  });
});

test("heartbeat history API: invalid limit は 400 を返す", async (t) => {
  const runLifecycle = new RunLifecycle({
    now: () => "2026-03-01T00:00:00.000Z",
    newMessageId: () => "msg_test",
  });
  const runEventBuffer = new RunEventBuffer({ retentionMs: 60_000 });
  const stateDir = await mkdtemp(join(tmpdir(), "adjutant-router-test-heartbeat-invalid-"));
  t.after(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });
  const threadRepository = ThreadRepository.fromStateDir(stateDir);
  await threadRepository.initialize();

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
    threadRepository,
    buildThreadSnapshot: () => {
      const thread = threadRepository.getOrVirtual("main");
      if (thread === undefined) {
        return undefined;
      }
      return {
        thread,
        runs: [],
        toolEventsByRun: {},
        pendingPermissions: [],
      };
    },
    supervisor: {
      request: async () => {
        throw new Error("not used");
      },
    } as unknown as WorkerSupervisor,
    permissionGateway: new PermissionGateway({
      emitUiEvent: () => {},
    }),
    runHeartbeat: async () => {
      throw new Error("not used");
    },
    getLastHeartbeat: () => null,
    listHeartbeatHistory: () => ({
      items: [],
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

  const response = await fetch(`http://127.0.0.1:${port}/api/heartbeat/history?limit=abc`);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    code: "INVALID_REQUEST",
    message: "limit must be a positive integer",
  });
});

test("GET /api/activity-feed returns newest-first unread-like items", async (t) => {
  const runLifecycle = new RunLifecycle({
    now: () => "2026-03-01T00:00:00.000Z",
    newMessageId: () => "msg_test",
  });
  const runEventBuffer = new RunEventBuffer({ retentionMs: 60_000 });
  const stateDir = await mkdtemp(join(tmpdir(), "adjutant-router-test-activity-feed-"));
  t.after(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });
  const threadRepository = ThreadRepository.fromStateDir(stateDir);
  await threadRepository.initialize();

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
    threadRepository,
    buildThreadSnapshot: () => undefined,
    supervisor: {
      request: async () => {
        throw new Error("not used");
      },
    } as unknown as WorkerSupervisor,
    permissionGateway: new PermissionGateway({
      emitUiEvent: () => {},
    }),
    buildActivityFeed: async (input) => ({
      items: [
        {
          activityId: "evt-1",
          ts: "2026-03-14T10:00:00.000Z",
          kind: "notification_received",
          messageText: "<@U1> test",
          sessionKey: "slack-activity",
          permalink: "https://workspace-alpha.slack.com/archives/C1/p1",
        },
      ],
      nextCursor: input?.cursor ? undefined : "MQ",
      generatedAt: "2026-03-14T10:00:05.000Z",
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

  const response = await fetch(`http://127.0.0.1:${port}/api/activity-feed?limit=10&cursor=MQ`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    items: [
      {
        activityId: "evt-1",
        ts: "2026-03-14T10:00:00.000Z",
        kind: "notification_received",
        messageText: "<@U1> test",
        sessionKey: "slack-activity",
        permalink: "https://workspace-alpha.slack.com/archives/C1/p1",
      },
    ],
    generatedAt: "2026-03-14T10:00:05.000Z",
  });
});

test("GET /api/activity-feed validates limit", async (t) => {
  const runLifecycle = new RunLifecycle({
    now: () => "2026-03-01T00:00:00.000Z",
    newMessageId: () => "msg_test",
  });
  const runEventBuffer = new RunEventBuffer({ retentionMs: 60_000 });
  const stateDir = await mkdtemp(join(tmpdir(), "adjutant-router-test-activity-feed-invalid-"));
  t.after(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });
  const threadRepository = ThreadRepository.fromStateDir(stateDir);
  await threadRepository.initialize();

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
    threadRepository,
    buildThreadSnapshot: () => undefined,
    supervisor: {
      request: async () => {
        throw new Error("not used");
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

  const response = await fetch(`http://127.0.0.1:${port}/api/activity-feed?limit=abc`);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    code: "INVALID_REQUEST",
    message: "limit must be a positive integer",
  });
});
