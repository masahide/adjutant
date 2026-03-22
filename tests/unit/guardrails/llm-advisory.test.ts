import assert from "node:assert/strict";
import test from "node:test";

import { createGuardrailLlmAdvisoryEvaluator } from "../../../src/guardrails/llm-advisory.js";

const input = {
  context: {
    sessionId: "sess_1",
    toolCallId: "tool_1",
    toolName: "write",
    input: {},
    toolKind: "write" as const,
    readOnly: false,
    hasExternalSideEffect: false,
  },
  raw: {
    sessionId: "sess_1",
    toolCallId: "tool_1",
    toolName: "write",
    input: {},
  },
};

test("GuardrailLlmAdvisoryEvaluator returns advisory for valid JSON output", async () => {
  const evaluate = createGuardrailLlmAdvisoryEvaluator({
    enabled: true,
    model: "gpt-5-mini",
    timeoutMs: 1000,
    client: {
      create: async () => ({
        output_text: JSON.stringify({
          recommendedDecision: "review",
          confidence: 0.82,
          reason: "side effect",
          tags: ["write"],
        }),
      }),
    },
  });

  const advisory = await evaluate(input);
  assert.deepEqual(advisory, {
    recommendedDecision: "review",
    confidence: 0.82,
    reason: "side effect",
    tags: ["write"],
  });
});

test("GuardrailLlmAdvisoryEvaluator falls back on malformed output and transport errors", async () => {
  const malformed = createGuardrailLlmAdvisoryEvaluator({
    enabled: true,
    model: "gpt-5-mini",
    timeoutMs: 1000,
    client: {
      create: async () => ({
        output_text: "{not-json}",
      }),
    },
  });
  assert.equal(await malformed(input), undefined);

  const failed = createGuardrailLlmAdvisoryEvaluator({
    enabled: true,
    model: "gpt-5-mini",
    timeoutMs: 1000,
    client: {
      create: async () => {
        throw new Error("timeout");
      },
    },
  });
  assert.equal(await failed(input), undefined);
});
