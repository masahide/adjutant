import assert from "node:assert/strict";
import test from "node:test";

import { PermissionGateway } from "../../../../src/control-plane/acp/permission-gateway.js";

test("PermissionGateway emits UI events and resolves permission outcome", async () => {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const gateway = new PermissionGateway({
    emitUiEvent: (event) => events.push(event),
  });

  const pending = gateway.requestPermission({
    requestId: "perm_1",
    sessionId: "sess_1",
    runId: "run_1",
    toolCallId: "call_1",
    title: "Allow file write",
  });

  const resolved = gateway.resolvePermission("perm_1", "allow");
  assert.equal(resolved, true);

  assert.equal(await pending, "allow");
  assert.equal(events[0]?.type, "permission/requested");
  assert.equal(events[1]?.type, "permission/resolved");
  assert.equal(events[1]?.payload.outcome, "allow");
});

test("PermissionGateway cancelSession resolves pending permission with cancelled", async () => {
  const gateway = new PermissionGateway();

  const pending = gateway.requestPermission({
    requestId: "perm_2",
    sessionId: "sess_cancel",
    title: "Allow terminal",
  });

  const cancelled = gateway.cancelSession("sess_cancel");
  assert.deepEqual(cancelled, ["perm_2"]);
  assert.equal(await pending, "cancelled");
});
