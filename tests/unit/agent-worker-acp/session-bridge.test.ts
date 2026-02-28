import assert from "node:assert/strict";
import test from "node:test";

import { SessionBridge } from "../../../src/agent-worker-acp/adapters/session-bridge.js";

test("SessionBridge maps sessionId to stable sessionKey and rolling runId", () => {
  const bridge = new SessionBridge();

  const base = bridge.ensureSession("sess_1");
  const run1 = bridge.startRun("sess_1");
  const run2 = bridge.startRun("sess_1");

  assert.equal(base.sessionKey, "session:sess_1");
  assert.equal(run1.runId, "session:sess_1:run:1");
  assert.equal(run2.runId, "session:sess_1:run:2");
});
