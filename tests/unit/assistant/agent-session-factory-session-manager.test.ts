import assert from "node:assert/strict";
import test from "node:test";

import {
  createPiSessionManager,
  resolvePiSessionFilePath,
} from "../../../src/assistant/agent-session-factory.js";

test("createPiSessionManager uses in-memory sessions when sessionId is absent", () => {
  const manager = createPiSessionManager({
    workspaceDir: process.cwd(),
  });

  assert.equal(manager.getSessionFile(), undefined);
});

test("createPiSessionManager uses a deterministic persisted session file when sessionId is present", () => {
  const manager = createPiSessionManager({
    workspaceDir: "/tmp/workspace",
    sessionId: "sess_main_1",
    stateDir: "/tmp/adjutant-state",
  });

  assert.equal(
    manager.getSessionFile(),
    "/tmp/adjutant-state/pi-sessions/sess_main_1.jsonl"
  );
});

test("resolvePiSessionFilePath sanitizes sessionId for filesystem safety", () => {
  const sessionFile = resolvePiSessionFilePath({
    sessionId: "sess:main/thread?1",
    stateDir: "/tmp/adjutant-state",
  });

  assert.equal(
    sessionFile,
    "/tmp/adjutant-state/pi-sessions/sess_main_thread_1.jsonl"
  );
});
