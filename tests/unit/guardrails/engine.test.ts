import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGuardrailPolicyCandidate,
  evaluateGuardrailDecision,
  normalizeGuardrailContext,
} from "../../../src/guardrails/engine.js";

test("guardrail allows sandboxed read-only tools", () => {
  const decision = evaluateGuardrailDecision({
    sessionId: "sess_1",
    toolCallId: "tool_1",
    toolName: "read",
    input: {
      path: "README.md",
    },
  });

  assert.equal(decision.decision, "allow");
  assert.equal(decision.ruleId, "allow-readonly-tools");
  assert.equal(decision.policySource, "builtin");
});

test("guardrail allows tool_hub discovery paths", () => {
  const decision = evaluateGuardrailDecision({
    sessionId: "sess_1",
    toolCallId: "tool_2",
    toolName: "tool_hub",
    input: {
      provider: "slack",
    },
  });

  assert.equal(decision.decision, "allow");
  assert.equal(decision.ruleId, "allow-tool-hub-discovery");
});

test("guardrail allows memory read actions and reviews memory write", () => {
  const readDecision = evaluateGuardrailDecision({
    sessionId: "sess_1",
    toolCallId: "tool_3",
    toolName: "tool_hub",
    input: {
      provider: "memory",
      action: "search",
      args: {
        query: "release note",
      },
    },
  });
  assert.equal(readDecision.decision, "allow");
  assert.equal(readDecision.ruleId, "allow-toolhub-memory-read");

  const writeDecision = evaluateGuardrailDecision({
    sessionId: "sess_1",
    toolCallId: "tool_4",
    toolName: "tool_hub",
    input: {
      provider: "memory",
      action: "write",
      args: {
        content: "hello",
      },
    },
  });
  assert.equal(writeDecision.decision, "review");
  assert.equal(writeDecision.ruleId, "review-toolhub-memory-write");
});

test("guardrail reviews slack provider actions by action-specific rule", () => {
  const decision = evaluateGuardrailDecision({
    sessionId: "sess_1",
    toolCallId: "tool_5",
    toolName: "tool_hub",
    input: {
      provider: "slack",
      action: "search",
      args: {
        mode: "search",
        query: "from:me",
      },
    },
  });

  assert.equal(decision.decision, "review");
  assert.equal(decision.ruleId, "review-toolhub-slack-actions");
});

test("guardrail forbids explicit bash escalation commands", () => {
  const decision = evaluateGuardrailDecision({
    sessionId: "sess_1",
    toolCallId: "tool_6",
    toolName: "bash",
    input: {
      command: "sudo rm -rf /tmp/test",
    },
  });

  assert.equal(decision.decision, "forbid");
  assert.equal(decision.ruleId, "forbid-bash-policy-escalation");
});

test("persisted policies override builtin review rules", () => {
  const decision = evaluateGuardrailDecision(
    {
      sessionId: "sess_1",
      toolCallId: "tool_7",
      toolName: "tool_hub",
      workspaceScopeKey: "projectRoot:/repo::workspaceDir:/workspace",
      input: {
        provider: "slack",
        action: "search",
        args: {
          mode: "search",
          query: "from:me",
        },
      },
    },
    {
      persistedPolicies: [
        {
          policyId: "policy_allow_slack_search",
          scope: "workspace",
          scopeKey: "projectRoot:/repo::workspaceDir:/workspace",
          match: {
            toolName: "tool_hub",
            toolHubMode: "execute",
            toolHubProvider: "slack",
            toolHubAction: "search",
          },
          effect: "allow",
          createdAt: "2026-03-22T00:00:00.000Z",
          createdBy: "user",
        },
      ],
    }
  );

  assert.equal(decision.decision, "allow");
  assert.equal(decision.ruleId, "policy_allow_slack_search");
  assert.equal(decision.policySource, "persisted");
});

test("persisted policies respect workspace scope and forbid still wins over allow", () => {
  const wrongScope = evaluateGuardrailDecision(
    {
      sessionId: "sess_1",
      toolCallId: "tool_8",
      toolName: "tool_hub",
      workspaceScopeKey: "projectRoot:/repo-a::workspaceDir:/workspace-a",
      input: {
        provider: "slack",
        action: "search",
        args: {
          mode: "search",
          query: "from:me",
        },
      },
    },
    {
      persistedPolicies: [
        {
          policyId: "policy_allow_other_workspace",
          scope: "workspace",
          scopeKey: "projectRoot:/repo-b::workspaceDir:/workspace-b",
          match: {
            toolName: "tool_hub",
            toolHubMode: "execute",
            toolHubProvider: "slack",
            toolHubAction: "search",
          },
          effect: "allow",
          createdAt: "2026-03-22T00:00:00.000Z",
          createdBy: "user",
        },
      ],
    }
  );
  assert.equal(wrongScope.decision, "review");

  const forbidWins = evaluateGuardrailDecision(
    {
      sessionId: "sess_1",
      toolCallId: "tool_9",
      toolName: "bash",
      workspaceScopeKey: "projectRoot:/repo::workspaceDir:/workspace",
      input: {
        command: "sudo whoami",
      },
    },
    {
      persistedPolicies: [
        {
          policyId: "policy_allow_sudo",
          scope: "workspace",
          scopeKey: "projectRoot:/repo::workspaceDir:/workspace",
          match: {
            toolName: "bash",
            bashCommandPrefix: "sudo",
          },
          effect: "allow",
          createdAt: "2026-03-22T00:00:00.000Z",
          createdBy: "user",
        },
      ],
    }
  );
  assert.equal(forbidWins.decision, "forbid");
  assert.equal(forbidWins.ruleId, "forbid-bash-policy-escalation");
});

test("buildGuardrailPolicyCandidate projects normalized context with path granularity", () => {
  const context = normalizeGuardrailContext({
    sessionId: "sess_1",
    toolCallId: "tool_10",
    toolName: "write",
    input: {
      path: "tmp.txt",
      content: "hello",
    },
  });

  assert.deepEqual(buildGuardrailPolicyCandidate(context), {
    toolName: "write",
    path: "tmp.txt",
  });
});
