import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeRouteClassifierDecision } from "../../src/proactive/route-classifier-decision.js";

describe("route-classifier-decision", () => {
  it("有効な判定を正規化する", () => {
    const result = normalizeRouteClassifierDecision({
      outcome: "pending",
      confidence: 0.75,
      reason: "fyi",
    });
    assert.deepEqual(result, {
      outcome: "pending",
      confidence: 0.75,
      reason: "fyi",
    });
  });

  it("confidence は 0..1 にクランプする", () => {
    const result = normalizeRouteClassifierDecision({
      outcome: "run",
      confidence: 9,
    });
    assert.equal(result.outcome, "run");
    assert.equal(result.confidence, 1);
  });

  it("契約外outcomeは例外", () => {
    assert.throws(
      () => normalizeRouteClassifierDecision({ outcome: "later" }),
      /route-llm-invalid-outcome/
    );
  });
});
