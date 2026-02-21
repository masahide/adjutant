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
    const { events, unsubscribe, replay } = Bridge.subscribe("run-1");
    assert.equal(replay.status, "ok");
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

  it("Last-Event-ID 用に afterSeq 以降のみ replay できる", async () => {
    Bridge.emit(makeEvent("run-1", 1, "delta", "a"));
    Bridge.emit(makeEvent("run-1", 2, "delta", "b"));
    Bridge.emit(makeEvent("run-1", 3, "final", "c"));

    const { events, replay } = Bridge.subscribe("run-1", { afterSeq: 1 });
    assert.equal(replay.status, "ok");
    const seqs: number[] = [];
    for await (const event of events) {
      seqs.push(event.seq);
    }
    assert.deepEqual(seqs, [2, 3]);
  });

  it("replay バッファ範囲外は expired を返す", () => {
    Bridge.configureReplay({ maxEventsPerRun: 2 });
    Bridge.emit(makeEvent("run-1", 1, "delta", "a"));
    Bridge.emit(makeEvent("run-1", 2, "delta", "b"));
    Bridge.emit(makeEvent("run-1", 3, "final", "c"));

    const result = Bridge.subscribe("run-1", { afterSeq: 0 });
    assert.equal(result.replay.status, "expired");
    if (result.replay.status === "expired") {
      assert.equal(result.replay.minAvailableSeq, 2);
      assert.equal(result.replay.maxAvailableSeq, 3);
    }
  });
});
