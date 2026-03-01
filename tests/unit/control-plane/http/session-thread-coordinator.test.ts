import assert from "node:assert/strict";
import test from "node:test";

import { SessionThreadCoordinator } from "../../../../src/control-plane/http/session-thread-coordinator.js";

test("SessionThreadCoordinator ensures thread via ThreadRepository", async () => {
  const ensured: string[] = [];
  const coordinator = new SessionThreadCoordinator({
    threadRepository: {
      ensureForSessionKey: async (sessionKey: string) => {
        ensured.push(sessionKey);
        return {
          threadId: sessionKey,
          title: "",
          archived: false,
          isDefault: false,
          createdAt: "2026-03-01T00:00:00.000Z",
          updatedAt: "2026-03-01T00:00:00.000Z",
        };
      },
    },
    recoveryStore: {
      upsert: async () => ({
        sessionKey: "main",
        sessionId: "sess_1",
        lastRunId: "session:sess_1:run:1",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    },
    toErrorSummary: () => ({
      errorCode: "DOWNSTREAM_ERROR",
      errorMessage: "unexpected",
    }),
  });

  await coordinator.ensureThreadForSession("main");
  assert.deepEqual(ensured, ["main"]);
});

test("SessionThreadCoordinator logs recovery upsert failure without throwing", async () => {
  const failures: Array<{ runId: string; sessionKey: string; errorCode: string; message: string }> =
    [];
  const coordinator = new SessionThreadCoordinator({
    threadRepository: {
      ensureForSessionKey: async () => ({
        threadId: "main",
        title: "",
        archived: false,
        isDefault: true,
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    },
    recoveryStore: {
      upsert: async () => {
        throw new Error("disk full");
      },
    },
    toErrorSummary: () => ({
      errorCode: "JOURNAL_APPEND_FAILED",
      errorMessage: "disk full",
    }),
    onRecoveryPersistFailed: (input) => {
      failures.push(input);
    },
  });

  await coordinator.persistSessionRecovery({
    runId: "session:sess_1:run:1",
    sessionKey: "main",
    sessionId: "sess_1",
    lastRunId: "session:sess_1:run:1",
  });

  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.errorCode, "JOURNAL_APPEND_FAILED");
});
