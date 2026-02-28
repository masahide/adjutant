import assert from "node:assert/strict";
import test from "node:test";

import { handleAuthenticate } from "../../../src/agent-worker-acp/handlers/authenticate.js";
import { handleInitialize } from "../../../src/agent-worker-acp/handlers/initialize.js";
import { handleSessionLoad } from "../../../src/agent-worker-acp/handlers/session-load.js";
import { handleSessionNew } from "../../../src/agent-worker-acp/handlers/session-new.js";
import { WorkerRuntimeError } from "../../../src/agent-worker-acp/errors.js";
import { WorkerSessionStore } from "../../../src/agent-worker-acp/session-store.js";
import { ACP_SCHEMA_VERSION } from "../../../src/contracts/acp/schema-version.js";

test("handleInitialize negotiates protocol and returns capabilities", () => {
  const result = handleInitialize(
    { protocolVersion: ACP_SCHEMA_VERSION },
    { enableLoadSession: true }
  );

  assert.equal(result.protocolVersion, ACP_SCHEMA_VERSION);
  assert.equal(result.agentCapabilities.loadSession, true);
  assert.equal(result.agentCapabilities.promptSession, true);
  assert.equal(result.agentCapabilities.cancelSession, true);
});

test("handleInitialize rejects protocol mismatch", () => {
  assert.throws(
    () => handleInitialize({ protocolVersion: 999 }),
    (error: unknown) => {
      assert.equal(error instanceof WorkerRuntimeError, true);
      assert.equal((error as WorkerRuntimeError).code, "ACP_PROTOCOL_ERROR");
      return true;
    }
  );
});

test("handleAuthenticate returns no-auth result", () => {
  const result = handleAuthenticate({});
  assert.deepEqual(result, { authenticated: true, authMethod: "none" });
});

test("handleSessionNew creates a session and handleSessionLoad loads it", () => {
  const sessionStore = new WorkerSessionStore();

  const created = handleSessionNew({ cwd: "/tmp" }, { sessionStore });
  const loaded = handleSessionLoad(
    { sessionId: created.sessionId },
    { sessionStore },
    { enableLoadSession: true }
  );

  assert.equal(typeof created.sessionId, "string");
  assert.equal(loaded.sessionId, created.sessionId);
});

test("handleSessionLoad is blocked by capability gate", () => {
  const sessionStore = new WorkerSessionStore();
  const created = handleSessionNew({}, { sessionStore });

  assert.throws(
    () =>
      handleSessionLoad(
        { sessionId: created.sessionId },
        { sessionStore },
        { enableLoadSession: false }
      ),
    (error: unknown) => {
      assert.equal(error instanceof WorkerRuntimeError, true);
      assert.equal((error as WorkerRuntimeError).code, "UNSUPPORTED_CAPABILITY");
      return true;
    }
  );
});
