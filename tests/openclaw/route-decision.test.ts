import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluateRouteState, normalizeRouteDecision } from "../../src/openclaw/route-decision.js";

describe("route-decision", () => {
  it("矛盾状態(run && pending)を拒否する", () => {
    assert.throws(
      () => normalizeRouteDecision({ run: true, pending: true, system: false, drop: false }),
      /run and pending/
    );
  });

  it("矛盾状態(drop と他フラグ併用)を拒否する", () => {
    assert.throws(
      () => normalizeRouteDecision({ run: true, pending: false, system: false, drop: true }),
      /drop must be exclusive/
    );
    assert.throws(
      () => normalizeRouteDecision({ run: false, pending: false, system: true, drop: true }),
      /drop must be exclusive/
    );
  });

  it("self の post は drop になる", () => {
    const decision = evaluateRouteState({
      selfState: "self",
      eventKind: "post",
      routerOutcome: "run",
    });
    assert.deepEqual(decision, {
      run: false,
      pending: false,
      system: false,
      drop: true,
      reason: "self-message",
    });
  });

  it("self 判定不可の reaction は system-only になる", () => {
    const decision = evaluateRouteState({
      selfState: "unknown",
      eventKind: "reaction",
      routerOutcome: "run",
    });
    assert.deepEqual(decision, {
      run: false,
      pending: false,
      system: true,
      drop: false,
      reason: "self-unknown-system-only",
    });
  });

  it("non-self の reaction は routerOutcome=pending を反映しつつ system=true", () => {
    const decision = evaluateRouteState({
      selfState: "non-self",
      eventKind: "reaction",
      routerOutcome: "pending",
    });
    assert.deepEqual(decision, {
      run: false,
      pending: true,
      system: true,
      drop: false,
      reason: undefined,
    });
  });
});
