import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NormalizedEvent } from "../../src/core/events.js";
import { createTriggerFilter } from "../../src/proactive/trigger-filter.js";

function makeEvent(kind: NormalizedEvent["kind"]): NormalizedEvent {
  return {
    schema: "adjutant.event.v1.1",
    uid: `uid-${kind}`,
    source: "slack",
    kind,
    ts: "2026-02-17T00:00:00+09:00",
  };
}

describe("trigger-filter", () => {
  it("secondary classifier が pending を返すと primary を上書きする", async () => {
    const filter = createTriggerFilter({
      primaryClassifier: () => "run",
      secondaryClassifier: async () => "pending",
    });

    const decision = await filter.decide({
      event: makeEvent("post"),
      selfState: "non-self",
    });

    assert.deepEqual(decision, {
      run: false,
      pending: true,
      system: false,
      drop: false,
      reason: undefined,
    });
  });

  it("secondary classifier が timeout したら primary へフォールバックする", async () => {
    const warnings: Array<{ message: string; meta?: Record<string, unknown> }> = [];
    const filter = createTriggerFilter({
      primaryClassifier: () => "run",
      secondaryTimeoutMs: 5,
      secondaryClassifier: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return "pending";
      },
      warn: (message, meta) => warnings.push({ message, meta }),
    });

    const decision = await filter.decide({
      event: makeEvent("post"),
      selfState: "non-self",
    });

    assert.equal(decision.run, true);
    assert.equal(decision.pending, false);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]?.message, "secondary-classifier-fallback-to-primary");
  });

  it("secondary classifier が例外を投げたら primary へフォールバックする", async () => {
    const warnings: Array<{ message: string; meta?: Record<string, unknown> }> = [];
    const filter = createTriggerFilter({
      primaryClassifier: () => "pending",
      secondaryClassifier: async () => {
        throw new Error("llm unavailable");
      },
      warn: (message, meta) => warnings.push({ message, meta }),
    });

    const decision = await filter.decide({
      event: makeEvent("post"),
      selfState: "non-self",
    });

    assert.equal(decision.run, false);
    assert.equal(decision.pending, true);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]?.message, "secondary-classifier-fallback-to-primary");
  });

  it("secondary classifier が契約外値を返したら primary へフォールバックする", async () => {
    const warnings: Array<{ message: string; meta?: Record<string, unknown> }> = [];
    const filter = createTriggerFilter({
      primaryClassifier: () => "run",
      secondaryClassifier: async () => "invalid" as unknown as "run",
      warn: (message, meta) => warnings.push({ message, meta }),
    });

    const decision = await filter.decide({
      event: makeEvent("post"),
      selfState: "non-self",
    });

    assert.equal(decision.run, true);
    assert.equal(decision.pending, false);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]?.message, "secondary-classifier-fallback-to-primary");
    assert.equal(warnings[0]?.meta?.reason, "invalid-secondary-outcome");
  });

  it("self 判定不可 reaction は常に system-only", async () => {
    const filter = createTriggerFilter({
      primaryClassifier: () => "run",
    });

    const decision = await filter.decide({
      event: makeEvent("reaction"),
      selfState: "unknown",
    });

    assert.deepEqual(decision, {
      run: false,
      pending: false,
      system: true,
      drop: false,
      reason: "self-unknown-system-only",
    });
  });
});
