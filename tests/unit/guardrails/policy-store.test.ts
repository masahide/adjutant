import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GuardrailPolicyStore } from "../../../src/guardrails/policy-store.js";

test("GuardrailPolicyStore persists policies and reloads after store recreation", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "adjutant-guardrail-policy-"));
  t.after(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  const first = GuardrailPolicyStore.fromStateDir(stateDir);
  await first.persistPolicy({
    scope: "workspace",
    scopeKey: "projectRoot:/repo::workspaceDir:/workspace",
    match: {
      toolName: "tool_hub",
      toolHubMode: "execute",
      toolHubProvider: "memory",
      toolHubAction: "write",
    },
    effect: "deny",
  });

  const second = GuardrailPolicyStore.fromStateDir(stateDir);
  const policies = await second.listPolicies();
  assert.equal(policies.length, 1);
  assert.equal(policies[0]?.effect, "deny");
  assert.deepEqual(policies[0]?.match, {
    toolName: "tool_hub",
    toolHubMode: "execute",
    toolHubProvider: "memory",
    toolHubAction: "write",
  });
  assert.equal(policies[0]?.scopeKey, "projectRoot:/repo::workspaceDir:/workspace");
});
