import assert from "node:assert/strict";
import test from "node:test";

import { resolveOrCreateSession } from "../../../../src/control-plane/acp/session-recovery-resolver.js";

type RecoveryStoreMock = {
  get: (sessionKey: string) => { sessionId: string; lastRunId?: string } | undefined;
  upsert: (input: { sessionKey: string; sessionId: string; lastRunId?: string }) => Promise<void>;
};

test("resolveOrCreateSession uses session/load when recovery exists and capability is enabled", async () => {
  const sessionsByKey = new Map();
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];

  const recoveryStore: RecoveryStoreMock = {
    get: (sessionKey) =>
      sessionKey === "main"
        ? {
            sessionId: "sess_recovered",
            lastRunId: "session:sess_recovered:run:7",
          }
        : undefined,
    upsert: async () => {},
  };

  const resolved = await resolveOrCreateSession("main", {
    sessionsByKey,
    recoveryStore: recoveryStore as never,
    isLoadSessionEnabled: true,
    requestWorker: async (method, params) => {
      calls.push({ method, params });
      if (method === "session/load") {
        return { sessionId: "sess_recovered" };
      }
      return { sessionId: "sess_new" };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, "session/load");
  assert.equal(resolved.sessionId, "sess_recovered");
  assert.equal(resolved.runSequence, 7);
  assert.equal(resolved.sessionRecovered, true);
  assert.equal(resolved.recoveryMode, "session_load");
});

test("resolveOrCreateSession falls back to session/new when session/load fails", async () => {
  const sessionsByKey = new Map();
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];

  const recoveryStore: RecoveryStoreMock = {
    get: () => ({
      sessionId: "sess_missing",
      lastRunId: "session:sess_missing:run:2",
    }),
    upsert: async () => {},
  };

  const resolved = await resolveOrCreateSession("main", {
    sessionsByKey,
    recoveryStore: recoveryStore as never,
    isLoadSessionEnabled: true,
    requestWorker: async (method, params) => {
      calls.push({ method, params });
      if (method === "session/load") {
        throw new Error("INVALID_RECORD");
      }
      return { sessionId: "sess_new" };
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.method, "session/load");
  assert.equal(calls[1]?.method, "session/new");
  assert.equal(resolved.sessionId, "sess_new");
  assert.equal(resolved.runSequence, 0);
  assert.equal(resolved.sessionRecovered, false);
  assert.equal(resolved.recoveryMode, "fallback_new_session");
  assert.equal(typeof resolved.fallbackReason, "string");
});

test("resolveOrCreateSession does not swallow non-recoverable session/load errors", async () => {
  const sessionsByKey = new Map();
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];

  const recoveryStore: RecoveryStoreMock = {
    get: () => ({
      sessionId: "sess_missing",
      lastRunId: "session:sess_missing:run:2",
    }),
    upsert: async () => {},
  };

  await assert.rejects(
    async () =>
      await resolveOrCreateSession("main", {
        sessionsByKey,
        recoveryStore: recoveryStore as never,
        isLoadSessionEnabled: true,
        requestWorker: async (method, params) => {
          calls.push({ method, params });
          if (method === "session/load") {
            throw new Error("WORKER_CRASHED: exit=1 signal=SIGKILL");
          }
          return { sessionId: "sess_new" };
        },
      }),
    /WORKER_CRASHED/
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, "session/load");
});

test("resolveOrCreateSession wraps recovery store errors with JOURNAL_APPEND_FAILED", async () => {
  const sessionsByKey = new Map();

  const recoveryStore: RecoveryStoreMock = {
    get: () => undefined,
    upsert: async () => {
      throw new Error("disk full");
    },
  };

  await assert.rejects(
    async () =>
      await resolveOrCreateSession("main", {
        sessionsByKey,
        recoveryStore: recoveryStore as never,
        isLoadSessionEnabled: true,
        requestWorker: async () => ({ sessionId: "sess_new" }),
      }),
    /JOURNAL_APPEND_FAILED/
  );
});
