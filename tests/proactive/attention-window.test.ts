import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAttentionWindow } from "../../src/proactive/attention-window.js";

describe("attention-window", () => {
  it("idle 到達で flush される", async () => {
    const flushed: string[][] = [];
    const window = createAttentionWindow<string>({
      onFlush: async ({ items }) => {
        flushed.push(items);
      },
    });

    window.push({ sessionKey: "s1", item: "a", idleMs: 10, maxWaitMs: 100 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(flushed, [["a"]]);
  });

  it("maxWait 到達で flush される", async () => {
    const flushed: string[][] = [];
    const window = createAttentionWindow<string>({
      onFlush: async ({ items }) => {
        flushed.push(items);
      },
    });

    window.push({ sessionKey: "s1", item: "a", idleMs: 100, maxWaitMs: 20 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    window.push({ sessionKey: "s1", item: "b", idleMs: 100, maxWaitMs: 20 });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.deepEqual(flushed, [["a", "b"]]);
  });

  it("flushSession は指定 session だけ即時 flush する", async () => {
    const flushed: Array<{ sessionKey: string; items: string[] }> = [];
    const window = createAttentionWindow<string>({
      onFlush: async ({ sessionKey, items }) => {
        flushed.push({ sessionKey, items });
      },
    });

    window.push({ sessionKey: "s1", item: "a", idleMs: 100, maxWaitMs: 1000 });
    window.push({ sessionKey: "s2", item: "x", idleMs: 100, maxWaitMs: 1000 });
    await window.flushSession("s1");
    assert.deepEqual(flushed, [{ sessionKey: "s1", items: ["a"] }]);

    await new Promise((resolve) => setTimeout(resolve, 140));
    assert.equal(flushed.length, 2);
    assert.equal(flushed[1]?.sessionKey, "s2");
    assert.deepEqual(flushed[1]?.items, ["x"]);
  });
});
