import assert from "node:assert/strict";
import test from "node:test";

import { PermissionGateway } from "../../../../src/control-plane/acp/permission-gateway.js";
import { handlePermissionRequest } from "../../../../src/control-plane/acp/permission-request-handler.js";

test("handlePermissionRequest bridges ACP review to PermissionGateway", async () => {
  const gateway = new PermissionGateway();

  const pending = handlePermissionRequest(
    {
      sessionId: "sess_1",
      toolCall: {
        toolCallId: "tool_1",
        title: "write",
      },
      options: [
        {
          optionId: "allow_once",
          name: "Approve",
          kind: "allow_once",
        },
        {
          optionId: "reject_once",
          name: "Deny",
          kind: "reject_once",
        },
      ],
      _meta: {
        guardrail: {
          title: "write requires approval",
          reason: "副作用のある実行は人間の承認が必要です。",
          ruleId: "review-side-effecting-tools",
        },
      },
    },
    {
      permissionGateway: gateway,
      resolveRunId: () => "run_1",
    }
  );

  const pendingPermissions = gateway.listPending("sess_1");
  assert.equal(pendingPermissions.length, 1);
  assert.equal(pendingPermissions[0]?.reason, "副作用のある実行は人間の承認が必要です。");
  assert.equal(pendingPermissions[0]?.ruleId, "review-side-effecting-tools");

  gateway.resolvePermission("tool_1", "allow");
  const response = await pending;
  assert.deepEqual(response, {
    outcome: {
      outcome: "selected",
      optionId: "allow_once",
    },
  });
});
