import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { StreamEvent } from "../../src/assistant/types.js";
import * as Bridge from "../../src/assistant/stream-event-bridge.js";

function makeEvent(
  runId: string,
  seq: number,
  state: StreamEvent["state"],
  message?: string
): StreamEvent {
  return {
    runId,
    sessionKey: "main",
    seq,
    state,
    message: message
      ? { role: "assistant", content: [{ type: "text", text: message }] }
      : undefined,
  };
}

describe("StreamEventBridge", () => {
  beforeEach(() => {
    Bridge.resetForTest();
  });

  it("emit + subscribe でイベントを受信できる", async () => {
    const { events, unsubscribe } = Bridge.subscribe("run-1");
    Bridge.emit(makeEvent("run-1", 1, "delta", "hello"));
    Bridge.emit(makeEvent("run-1", 2, "final", "done"));

    const collected: StreamEvent[] = [];
    for await (const ev of events) {
      collected.push(ev);
      if (ev.state === "final") break;
    }
    unsubscribe();

    assert.equal(collected.length, 2);
    assert.equal(collected[0].seq, 1);
    assert.equal(collected[0].state, "delta");
    assert.equal(collected[1].seq, 2);
    assert.equal(collected[1].state, "final");
  });

  it("終端 state 後の emit は無視される", () => {
    Bridge.emit(makeEvent("run-1", 1, "final"));
    Bridge.emit(makeEvent("run-1", 2, "delta", "should be ignored"));
    assert.equal(Bridge.getTerminal("run-1")?.seq, 1);
  });

  it("error state も終端として扱われる", () => {
    Bridge.emit(makeEvent("run-1", 1, "error"));
    assert.notEqual(Bridge.getTerminal("run-1"), null);
  });

  it("aborted state も終端として扱われる", () => {
    Bridge.emit(makeEvent("run-1", 1, "aborted"));
    assert.notEqual(Bridge.getTerminal("run-1"), null);
  });

  it("完了済み run への subscribe は即時にイベントを返す", async () => {
    Bridge.emit(makeEvent("run-1", 1, "delta", "hi"));
    Bridge.emit(makeEvent("run-1", 2, "final", "bye"));

    const { events, unsubscribe } = Bridge.subscribe("run-1");
    const collected: StreamEvent[] = [];
    for await (const ev of events) {
      collected.push(ev);
      if (ev.state === "final") break;
    }
    unsubscribe();

    assert.equal(collected.length, 2);
    assert.equal(collected[1].state, "final");
  });

  it("hasRun は登録済み run を判定", () => {
    assert.equal(Bridge.hasRun("none"), false);
    Bridge.emit(makeEvent("run-1", 1, "delta"));
    assert.equal(Bridge.hasRun("run-1"), true);
  });
});
