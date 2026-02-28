import assert from "node:assert/strict";
import test from "node:test";

import {
  ACP_CLIENT_METHODS,
  ACP_UNSTABLE_AGENT_METHODS,
} from "../../src/contracts/acp/method-types.js";
import {
  buildCapabilityMatrix,
  isAgentMethodEnabled,
  isClientMethodEnabled,
} from "../../src/control-plane/acp/capability-matrix.js";

test("capability matrix keeps FS and unstable methods disabled by default", () => {
  const matrix = buildCapabilityMatrix();

  assert.equal(isAgentMethodEnabled(matrix, ACP_UNSTABLE_AGENT_METHODS.SESSION_LIST), false);
  assert.equal(isClientMethodEnabled(matrix, ACP_CLIENT_METHODS.FS_READ_TEXT_FILE), false);
});

test("capability matrix can enable unstable and fs methods via flags", () => {
  const matrix = buildCapabilityMatrix({
    enableUnstableSessionMethods: true,
    enableFsCapability: true,
  });

  assert.equal(isAgentMethodEnabled(matrix, ACP_UNSTABLE_AGENT_METHODS.SESSION_LIST), true);
  assert.equal(isClientMethodEnabled(matrix, ACP_CLIENT_METHODS.FS_READ_TEXT_FILE), true);
});
