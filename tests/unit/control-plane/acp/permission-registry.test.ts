import assert from "node:assert/strict";
import test from "node:test";

import { PermissionRegistry } from "../../../../src/control-plane/acp/permission-registry.js";

test("PermissionRegistry register + resolve returns outcome", async () => {
  const registry = new PermissionRegistry();

  const pending = registry.register({
    requestId: "perm_1",
    sessionId: "sess_1",
    title: "Allow tool",
  });

  const resolved = registry.resolve("perm_1", "allow_once");
  assert.equal(resolved, true);

  const outcome = await pending;
  assert.equal(outcome, "allow_once");
});

test("PermissionRegistry cancelBySession resolves pending as cancelled", async () => {
  const registry = new PermissionRegistry();

  const p1 = registry.register({ requestId: "perm_1", sessionId: "sess_1", title: "A" });
  const p2 = registry.register({ requestId: "perm_2", sessionId: "sess_2", title: "B" });

  const cancelled = registry.cancelBySession("sess_1");
  assert.deepEqual(cancelled, ["perm_1"]);

  assert.equal(await p1, "cancelled");
  registry.resolve("perm_2", "reject_once");
  assert.equal(await p2, "reject_once");
});
