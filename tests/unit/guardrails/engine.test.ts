import assert from "node:assert/strict";
import test from "node:test";

import { evaluateGuardrailDecision } from "../../../src/guardrails/engine.js";

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

test("guardrail sends side-effecting tool_hub execution to review", () => {
  const decision = evaluateGuardrailDecision({
    sessionId: "sess_1",
    toolCallId: "tool_3",
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
  assert.equal(decision.ruleId, "review-side-effecting-tools");
});

test("guardrail forbids explicit bash escalation commands", () => {
  const decision = evaluateGuardrailDecision({
    sessionId: "sess_1",
    toolCallId: "tool_4",
    toolName: "bash",
    input: {
      command: "sudo rm -rf /tmp/test",
    },
  });

  assert.equal(decision.decision, "forbid");
  assert.equal(decision.ruleId, "forbid-bash-policy-escalation");
});
