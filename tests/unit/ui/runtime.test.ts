import assert from "node:assert/strict";
import test from "node:test";

import { UiRuntime } from "../../../src/ui/runtime.js";

test("UiRuntime tracks pending permissions across request/resolve events", () => {
  const runtime = new UiRuntime({
    resolveRunId: (sessionId) => (sessionId === "sess_1" ? "run_1" : undefined),
  });

  runtime.onPermissionEvent({
    type: "permission/requested",
    payload: {
      requestId: "perm_1",
      sessionId: "sess_1",
      title: "Allow tool",
    },
  });

  assert.equal(runtime.listPendingPermissions().length, 1);

  runtime.onPermissionEvent({
    type: "permission/resolved",
    payload: {
      requestId: "perm_1",
      outcome: "allow",
    },
  });

  assert.equal(runtime.listPendingPermissions().length, 0);
});
