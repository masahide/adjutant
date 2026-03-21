import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSessionWithRecovery } from "../../src/assistant/session-store-repository.js";

describe("session-store-repository", () => {
  it("session 破損時に repair 後リトライする", async () => {
    let createCalls = 0;
    let repaired = false;

    const result = await createSessionWithRecovery({
      runtime: {
        openSessionManager: () => ({}),
        createSession: async () => {
          createCalls += 1;
          if (createCalls === 1) {
            throw new Error("session json parse error");
          }
          return {
            session: {
              subscribe: () => () => undefined,
              prompt: async () => undefined,
              dispose: () => undefined,
            },
          };
        },
        loadSessionEntryStore: async () => ({
          path: "/tmp/sessions.json",
          store: { main: {} },
        }),
        saveSessionEntryStore: async () => "/tmp/sessions.json",
        repairSessionData: async () => {
          repaired = true;
          return true;
        },
      },
      runId: "run-1",
      sessionKey: "main",
      sessionEntriesPath: "/tmp/sessions.json",
      sessionStoreState: { path: "/tmp/sessions.json", store: { main: {} } },
      workspaceDir: "/tmp/workspace",
      model: "gpt-5.4-mini",
      isHeartbeat: false,
      memoryWriteEnabled: false,
      memoryScope: "main",
    });

    assert.equal(repaired, true);
    assert.equal(createCalls, 2);
    assert.equal(
      typeof result.previousUpdatedAt === "string" || result.previousUpdatedAt === null,
      true
    );
  });
});
