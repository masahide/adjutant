import assert from "node:assert/strict";
import test from "node:test";

import { RunEventBuffer } from "../../../src/control-plane/http/run-event-buffer.js";

test("append 時に seq が単調増加し replay できる", () => {
  const buffer = new RunEventBuffer({ retentionMs: 60_000 });
  buffer.ensureRun("run_1", "main");
  buffer.append("run_1", {
    state: "delta",
    runId: "run_1",
    sessionKey: "main",
    message: "a",
  });
  buffer.append("run_1", {
    state: "final",
    runId: "run_1",
    sessionKey: "main",
    message: "ab",
  });

  const replay = buffer.replay("run_1", 1);
  assert.equal(replay.length, 2);
  assert.equal(replay[0]?.seq, 1);
  assert.equal(replay[1]?.seq, 2);
});

test("subscribe で live event を受信できる", () => {
  const buffer = new RunEventBuffer({ retentionMs: 60_000 });
  buffer.ensureRun("run_2", "main");

  const received: number[] = [];
  const unsubscribe = buffer.subscribe("run_2", (event) => {
    received.push(event.seq);
  });
  buffer.append("run_2", {
    state: "delta",
    runId: "run_2",
    sessionKey: "main",
    message: "x",
  });
  unsubscribe();
  buffer.append("run_2", {
    state: "delta",
    runId: "run_2",
    sessionKey: "main",
    message: "y",
  });
  assert.deepEqual(received, [1]);
});

test("terminal event 後に retention 経過で dispose される", async () => {
  let timeoutId = 0;
  const scheduled = new Map<number, () => void>();
  const buffer = new RunEventBuffer({
    retentionMs: 10,
    setTimeoutFn: (callback) => {
      timeoutId += 1;
      scheduled.set(timeoutId, callback);
      return timeoutId as unknown as NodeJS.Timeout;
    },
    clearTimeoutFn: (timer) => {
      scheduled.delete(timer as unknown as number);
    },
  });
  buffer.ensureRun("run_3", "main");
  buffer.append("run_3", {
    state: "final",
    runId: "run_3",
    sessionKey: "main",
    message: "done",
  });
  assert.equal(buffer.hasRun("run_3"), true);

  const callback = scheduled.get(1);
  assert.equal(typeof callback, "function");
  callback?.();

  assert.equal(buffer.hasRun("run_3"), false);
});
