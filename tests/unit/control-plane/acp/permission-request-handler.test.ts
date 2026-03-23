import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PermissionGateway } from "../../../../src/control-plane/acp/permission-gateway.js";
import { handlePermissionRequest } from "../../../../src/control-plane/acp/permission-request-handler.js";
import { GuardrailPolicyStore } from "../../../../src/guardrails/policy-store.js";

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
          optionId: "allow_always",
          name: "Always Approve",
          kind: "allow_always",
        },
        {
          optionId: "reject_once",
          name: "Deny",
          kind: "reject_once",
        },
        {
          optionId: "reject_always",
          name: "Always Deny",
          kind: "reject_always",
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

  gateway.resolvePermission("tool_1", "allow_once");
  const response = await pending;
  assert.deepEqual(response, {
    outcome: {
      outcome: "selected",
      optionId: "allow_once",
    },
  });
});

test("handlePermissionRequest persists allow_always policy candidates", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "adjutant-permission-handler-"));
  t.after(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });
  const policyStore = GuardrailPolicyStore.fromStateDir(stateDir);
  const gateway = new PermissionGateway();

  const pending = handlePermissionRequest(
    {
      sessionId: "sess_1",
      toolCall: {
        toolCallId: "tool_2",
        title: "tool_hub",
      },
      options: [
        {
          optionId: "allow_once",
          name: "Approve",
          kind: "allow_once",
        },
        {
          optionId: "allow_always",
          name: "Always Approve",
          kind: "allow_always",
        },
        {
          optionId: "reject_once",
          name: "Deny",
          kind: "reject_once",
        },
        {
          optionId: "reject_always",
          name: "Always Deny",
          kind: "reject_always",
        },
      ],
      _meta: {
        guardrail: {
          title: "tool_hub slack/search requires approval",
          reason: "slack action requires approval",
          ruleId: "review-toolhub-slack-actions",
          workspaceScopeKey: "projectRoot:/repo::workspaceDir:/workspace",
          policyCandidate: {
            toolName: "tool_hub",
            toolHubMode: "execute",
            toolHubProvider: "slack",
            toolHubAction: "search",
          },
        },
      },
    },
    {
      permissionGateway: gateway,
      policyStore,
    }
  );

  gateway.resolvePermission("tool_2", "allow_always");
  const response = await pending;
  assert.deepEqual(response, {
    outcome: {
      outcome: "selected",
      optionId: "allow_always",
    },
  });

  const persisted = JSON.parse(
    await readFile(join(stateDir, "guardrails", "policies.json"), "utf8")
  ) as {
    policies: Array<{ effect: string; match: Record<string, unknown>; scopeKey?: string }>;
  };
  assert.equal(persisted.policies.length, 1);
  assert.equal(persisted.policies[0]?.effect, "allow");
  assert.deepEqual(persisted.policies[0]?.match, {
    toolName: "tool_hub",
    toolHubMode: "execute",
    toolHubProvider: "slack",
    toolHubAction: "search",
  });
  assert.equal(persisted.policies[0]?.scopeKey, "projectRoot:/repo::workspaceDir:/workspace");
});

test("handlePermissionRequest keeps current selection even when policy persistence fails", async () => {
  const gateway = new PermissionGateway();
  const warnings: Array<{ message: string; meta?: Record<string, unknown> }> = [];

  const pending = handlePermissionRequest(
    {
      sessionId: "sess_1",
      toolCall: {
        toolCallId: "tool_3",
        title: "write",
      },
      options: [
        {
          optionId: "allow_once",
          name: "Approve",
          kind: "allow_once",
        },
        {
          optionId: "allow_always",
          name: "Always Approve",
          kind: "allow_always",
        },
        {
          optionId: "reject_once",
          name: "Deny",
          kind: "reject_once",
        },
        {
          optionId: "reject_always",
          name: "Always Deny",
          kind: "reject_always",
        },
      ],
      _meta: {
        guardrail: {
          title: "write requires approval",
          reason: "副作用のある実行は人間の承認が必要です。",
          ruleId: "review-side-effecting-tools",
          workspaceScopeKey: "projectRoot:/repo::workspaceDir:/workspace",
          policyCandidate: {
            toolName: "write",
            path: "tmp.txt",
          },
        },
      },
    },
    {
      permissionGateway: gateway,
      policyStore: {
        persistPolicy: async () => {
          throw new Error("disk full");
        },
      } as unknown as GuardrailPolicyStore,
      onWarn: (message, meta) => {
        warnings.push({ message, meta });
      },
    }
  );

  gateway.resolvePermission("tool_3", "allow_always");
  const response = await pending;
  assert.deepEqual(response, {
    outcome: {
      outcome: "selected",
      optionId: "allow_always",
    },
  });
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]?.message, "failed to persist guardrail policy candidate");
  assert.equal(warnings[0]?.meta?.error, "disk full");
});
