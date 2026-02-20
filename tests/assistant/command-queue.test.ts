import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  clearCommandLane,
  CommandQueueClearedError,
  enqueueCommand,
  enqueueCommandInLane,
  getQueueSize,
  isGlobalIdle,
  isIdle,
  resolveSessionLane,
  setCommandLaneConcurrency,
  resetCommandQueueForTest,
} from "../../src/assistant/command-queue.js";

describe("CommandQueue", () => {
  afterEach(() => {
    resetCommandQueueForTest();
  });

  it("同一レーンは直列実行される", async () => {
    let active = 0;
    let maxActive = 0;
    const order: number[] = [];

    const task = (id: number) => async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push(id);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return id;
    };

    const results = await Promise.all([
      enqueueCommand(task(1)),
      enqueueCommand(task(2)),
      enqueueCommand(task(3)),
    ]);
    assert.deepEqual(results, [1, 2, 3]);
    assert.deepEqual(order, [1, 2, 3]);
    assert.equal(maxActive, 1);
    assert.equal(getQueueSize("main"), 0);
  });

  it("異なる session レーンは並行実行できる", async () => {
    let active = 0;
    let maxActive = 0;
    const started: string[] = [];

    const makeTask = (label: string) => async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      started.push(label);
      await new Promise((resolve) => setTimeout(resolve, 30));
      active -= 1;
      return label;
    };

    const laneA = resolveSessionLane("alpha");
    const laneB = resolveSessionLane("beta");
    const [a, b] = await Promise.all([
      enqueueCommandInLane(laneA, makeTask("a")),
      enqueueCommandInLane(laneB, makeTask("b")),
    ]);

    assert.equal(a, "a");
    assert.equal(b, "b");
    assert.equal(maxActive >= 2, true);
    assert.deepEqual(started.sort(), ["a", "b"]);
  });

  it("同一レーンでも concurrency 設定で並行実行できる", async () => {
    const lane = resolveSessionLane("parallel");
    setCommandLaneConcurrency(lane, 2);
    let active = 0;
    let maxActive = 0;

    const makeTask = (id: number) => async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return id;
    };

    const results = await Promise.all([
      enqueueCommandInLane(lane, makeTask(1)),
      enqueueCommandInLane(lane, makeTask(2)),
      enqueueCommandInLane(lane, makeTask(3)),
    ]);

    assert.deepEqual(results.sort(), [1, 2, 3]);
    assert.equal(maxActive, 2);
  });

  it("isIdle / isGlobalIdle を判定できる", async () => {
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });

    const running = enqueueCommand(async () => {
      await blocker;
      return "done";
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(isIdle("main"), false);
    assert.equal(isGlobalIdle(), false);

    release();
    await running;
    assert.equal(isIdle("main"), true);
    assert.equal(isGlobalIdle(), true);
  });

  it("getQueueSize は実行中 + 待機中を返す", async () => {
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = enqueueCommand(async () => {
      await blocker;
      return "first";
    });
    const second = enqueueCommand(async () => "second");

    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(getQueueSize("main"), 2);

    release();
    const results = await Promise.all([first, second]);
    assert.deepEqual(results, ["first", "second"]);
    assert.equal(getQueueSize("main"), 0);
  });

  it("clearCommandLane は待機中ジョブを削除し reject する", async () => {
    const lane = resolveSessionLane("clear-target");
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = enqueueCommandInLane(lane, async () => {
      await blocker;
      return "first";
    });
    const second = enqueueCommandInLane(lane, async () => "second");
    const third = enqueueCommandInLane(lane, async () => "third");

    await new Promise((resolve) => setTimeout(resolve, 5));
    const removed = clearCommandLane(lane);

    assert.equal(removed, 2);
    assert.equal(getQueueSize(lane), 1);

    release();
    assert.equal(await first, "first");
    await assert.rejects(second, (error: unknown) => {
      assert.equal(error instanceof CommandQueueClearedError, true);
      assert.equal((error as CommandQueueClearedError).lane, lane);
      return true;
    });
    await assert.rejects(third, (error: unknown) => {
      assert.equal(error instanceof CommandQueueClearedError, true);
      assert.equal((error as CommandQueueClearedError).lane, lane);
      return true;
    });
  });

  it("待機時間が閾値を超えると onWait が呼ばれる", async () => {
    let warningLane = "";
    let warningMs = 0;

    const first = enqueueCommand(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return "first";
    });
    const second = enqueueCommand(async () => "second", {
      warnAfterMs: 5,
      onWait: (warning) => {
        warningLane = warning.lane;
        warningMs = warning.waitMs;
      },
    });

    await Promise.all([first, second]);
    assert.equal(warningLane, "main");
    assert.equal(warningMs >= 5, true);
  });
});
