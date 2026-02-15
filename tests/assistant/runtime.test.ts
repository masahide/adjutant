import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeBackoff } from "../../src/ui/runtime.js";

describe("UI Runtime", () => {
  it("computeBackoff: attempt=1 は initial 付近 (2000ms ± jitter)", () => {
    const values = Array.from({ length: 100 }, () => computeBackoff(1));
    const min = Math.min(...values);
    const max = Math.max(...values);
    assert.ok(min >= 1500, `min ${min} should be >= 1500`);
    assert.ok(max <= 2500, `max ${max} should be <= 2500`);
  });

  it("computeBackoff: attempt が増えると delay も増加する", () => {
    const medians = [1, 3, 5, 8].map((attempt) => {
      const vals = Array.from({ length: 50 }, () => computeBackoff(attempt));
      vals.sort((a, b) => a - b);
      return vals[25];
    });
    for (let i = 1; i < medians.length; i++) {
      assert.ok(
        medians[i] > medians[i - 1],
        `median at attempt ${[1, 3, 5, 8][i]} (${medians[i]}) should be > median at attempt ${[1, 3, 5, 8][i - 1]} (${medians[i - 1]})`
      );
    }
  });

  it("computeBackoff: max を超えない", () => {
    const values = Array.from({ length: 100 }, () => computeBackoff(20));
    const max = Math.max(...values);
    assert.ok(max <= 37500, `max ${max} should be <= 37500 (30000 * 1.25)`);
  });
});
