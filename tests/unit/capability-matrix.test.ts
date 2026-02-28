import assert from "node:assert/strict";
import test from "node:test";

import {
  ACP_CLIENT_METHODS,
  ACP_UNSTABLE_AGENT_METHODS,
} from "../../src/contracts/acp/method-types.js";
import {
  ACP_V1_FS_CAPABILITY_ENABLED,
  buildCapabilityMatrix,
  isAgentMethodEnabled,
  isClientMethodEnabled,
} from "../../src/control-plane/acp/capability-matrix.js";

test("capability matrix keeps FS and unstable methods disabled by default", () => {
  const matrix = buildCapabilityMatrix();

  assert.equal(isAgentMethodEnabled(matrix, ACP_UNSTABLE_AGENT_METHODS.SESSION_LIST), false);
  assert.equal(isClientMethodEnabled(matrix, ACP_CLIENT_METHODS.FS_READ_TEXT_FILE), false);
});

test("capability matrix can enable unstable methods via flags", () => {
  const matrix = buildCapabilityMatrix({
    enableUnstableSessionMethods: true,
  });

  assert.equal(isAgentMethodEnabled(matrix, ACP_UNSTABLE_AGENT_METHODS.SESSION_LIST), true);
});

test("FS capability remains disabled in v1 even when enableFsCapability is true", () => {
  const matrix = buildCapabilityMatrix({
    enableFsCapability: true,
  });

  assert.equal(ACP_V1_FS_CAPABILITY_ENABLED, false);
  assert.equal(isClientMethodEnabled(matrix, ACP_CLIENT_METHODS.FS_READ_TEXT_FILE), false);
});
