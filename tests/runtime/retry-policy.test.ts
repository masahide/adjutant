import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeFullJitterDelayMs } from "../../src/runtime/retry-policy.js";

describe("retry-policy", () => {
  it("full jitter は 0..maxDelay の範囲に収まる", () => {
    const low = computeFullJitterDelayMs({
      attempt: 3,
      baseMs: 1000,
      capMs: 10000,
      random: () => 0,
    });
    const high = computeFullJitterDelayMs({
      attempt: 3,
      baseMs: 1000,
      capMs: 10000,
      random: () => 1,
    });
    assert.equal(low, 0);
    assert.equal(high, 4000);
  });

  it("cap を超えない", () => {
    const capped = computeFullJitterDelayMs({
      attempt: 10,
      baseMs: 1000,
      capMs: 5000,
      random: () => 1,
    });
    assert.equal(capped, 5000);
  });
});
