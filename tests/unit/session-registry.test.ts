import assert from "node:assert/strict";
import test from "node:test";

import {
  SessionRegistry,
  toRunId,
  toSessionKey,
} from "../../src/control-plane/acp/session-registry.js";

test("SessionRegistry maps sessionId -> sessionKey -> runId", () => {
  const registry = new SessionRegistry();

  const session = registry.registerSession("sess_abc");
  assert.equal(session.sessionKey, toSessionKey("sess_abc"));
  assert.equal(session.runId, toRunId(session.sessionKey, 0));

  const run1 = registry.startRun("sess_abc");
  assert.equal(run1.runId, toRunId(session.sessionKey, 1));

  assert.deepEqual(registry.resolveBySessionId("sess_abc"), run1);
  assert.deepEqual(registry.resolveBySessionKey(toSessionKey("sess_abc")), run1);
});
