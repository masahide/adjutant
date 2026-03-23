import assert from "node:assert/strict";
import test from "node:test";

import {
  ControlPlaneClient,
  requestPermissionFromControlPlane,
} from "../../../src/agent-worker-acp/control-plane-client.js";

test("requestPermissionFromControlPlane falls back to deny on RPC timeout", async () => {
  const envelopes: unknown[] = [];
  const client = new ControlPlaneClient({
    writeEnvelope: (envelope) => {
      envelopes.push(envelope);
    },
  });

  const originalTimeoutMs = process.env.ADJUTANT_GUARDRAIL_RPC_TIMEOUT_MS;
  const originalOutcome = process.env.ADJUTANT_GUARDRAIL_RPC_TIMEOUT_OUTCOME;
  process.env.ADJUTANT_GUARDRAIL_RPC_TIMEOUT_MS = "5";
  process.env.ADJUTANT_GUARDRAIL_RPC_TIMEOUT_OUTCOME = "deny";

  try {
    const outcome = await requestPermissionFromControlPlane(client, {
      sessionId: "sess_1",
      toolCallId: "tool_1",
      toolName: "write",
      title: "write requires approval",
      reason: "side effect",
    });
    assert.equal(outcome, "deny");
    assert.equal(envelopes.length, 1);
  } finally {
    if (originalTimeoutMs === undefined) {
      delete process.env.ADJUTANT_GUARDRAIL_RPC_TIMEOUT_MS;
    } else {
      process.env.ADJUTANT_GUARDRAIL_RPC_TIMEOUT_MS = originalTimeoutMs;
    }
    if (originalOutcome === undefined) {
      delete process.env.ADJUTANT_GUARDRAIL_RPC_TIMEOUT_OUTCOME;
    } else {
      process.env.ADJUTANT_GUARDRAIL_RPC_TIMEOUT_OUTCOME = originalOutcome;
    }
  }
});
