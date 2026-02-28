import assert from "node:assert/strict";
import test from "node:test";

import { ACP_UNSTABLE_AGENT_METHODS } from "../../../src/contracts/acp/method-types.js";
import { guardUnstableMethod, isUnstableMethod } from "../../../src/control-plane/acp/unstable.js";

test("unstable guard blocks session/list when feature flag is disabled", () => {
  const result = guardUnstableMethod(ACP_UNSTABLE_AGENT_METHODS.SESSION_LIST, {
    enableUnstableSessionMethods: false,
  });

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "UNSUPPORTED_CAPABILITY");
});

test("unstable guard allows session/resume when feature flag is enabled", () => {
  const result = guardUnstableMethod(ACP_UNSTABLE_AGENT_METHODS.SESSION_RESUME, {
    enableUnstableSessionMethods: true,
  });

  assert.deepEqual(result, { ok: true });
});

test("isUnstableMethod identifies only unstable ACP methods", () => {
  assert.equal(isUnstableMethod("session/fork"), true);
  assert.equal(isUnstableMethod("session/new"), false);
});
