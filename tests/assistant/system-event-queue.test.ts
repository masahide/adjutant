import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  drainSystemEventEntries,
  drainSystemEvents,
  enqueueSystemEvent,
  hasSystemEvents,
  isSystemEventContextChanged,
  peekSystemEvents,
  resetSystemEventQueueForTest,
} from "../../src/assistant/system-event-queue.js";

describe("SystemEventQueue", () => {
  afterEach(() => {
    resetSystemEventQueueForTest();
  });

  it("enqueue 順に drain される", () => {
    enqueueSystemEvent("event-1", { sessionKey: "main" });
    enqueueSystemEvent("event-2", { sessionKey: "main" });

    const drained = drainSystemEvents("main");
    assert.deepEqual(drained, ["event-1", "event-2"]);
    assert.deepEqual(drainSystemEvents("main"), []);
  });

  it("sessionKey ごとに分離される", () => {
    enqueueSystemEvent("main-event", { sessionKey: "main" });
    enqueueSystemEvent("other-event", { sessionKey: "other" });

    assert.deepEqual(drainSystemEvents("main"), ["main-event"]);
    assert.deepEqual(drainSystemEvents("other"), ["other-event"]);
  });

  it("MAX_EVENTS=20 を超えた場合は古い方から捨てる", () => {
    for (let i = 1; i <= 25; i += 1) {
      enqueueSystemEvent(`event-${i}`, { sessionKey: "main" });
    }

    const drained = drainSystemEvents("main");
    assert.equal(drained.length, 20);
    assert.equal(drained[0], "event-6");
    assert.equal(drained[19], "event-25");
  });

  it("連続同一テキストは重複投入しない", () => {
    enqueueSystemEvent("duplicate", { sessionKey: "main" });
    enqueueSystemEvent("duplicate", { sessionKey: "main" });
    enqueueSystemEvent("different", { sessionKey: "main" });

    assert.deepEqual(peekSystemEvents("main"), ["duplicate", "different"]);
  });

  it("contextKey 変化を検知できる", () => {
    assert.equal(isSystemEventContextChanged("main", "node:a"), true);
    enqueueSystemEvent("event-1", { sessionKey: "main", contextKey: "node:a" });
    assert.equal(isSystemEventContextChanged("main", "node:a"), false);
    assert.equal(isSystemEventContextChanged("main", "node:b"), true);
  });

  it("drain 後は queue と lastText がクリアされる", () => {
    enqueueSystemEvent("event-1", { sessionKey: "main", contextKey: "ctx-1" });
    assert.equal(hasSystemEvents("main"), true);

    const entries = drainSystemEventEntries("main");
    assert.equal(entries.length, 1);
    assert.equal(hasSystemEvents("main"), false);
    assert.equal(isSystemEventContextChanged("main", "ctx-1"), true);
  });

  it("空の sessionKey は例外", () => {
    assert.throws(() => enqueueSystemEvent("event", { sessionKey: " " }), /sessionKey/);
  });
});
