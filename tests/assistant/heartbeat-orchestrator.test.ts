import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HeartbeatOrchestrator } from "../../src/assistant/heartbeat-orchestrator.js";
import type { HeartbeatRunResult } from "../../src/assistant/types.js";

function createScheduler() {
  let nextId = 1;
  const intervals = new Map<number, () => void>();
  const timeouts = new Map<number, () => void>();

  const toHandle = (id: number): ReturnType<typeof setTimeout> =>
    ({ id }) as unknown as ReturnType<typeof setTimeout>;
  const toId = (handle: ReturnType<typeof setTimeout>): number =>
    (handle as unknown as { id: number }).id;

  return {
    intervalCount: () => intervals.size,
    timeoutCount: () => timeouts.size,
    fireInterval: () => {
      const fn = intervals.values().next().value as (() => void) | undefined;
      fn?.();
    },
    fireTimeout: () => {
      const entry = timeouts.entries().next().value as [number, () => void] | undefined;
      if (!entry) {
        return;
      }
      timeouts.delete(entry[0]);
      entry[1]();
    },
    setInterval: (fn: () => void) => {
      const id = nextId++;
      intervals.set(id, fn);
      return toHandle(id);
    },
    clearInterval: (timer: ReturnType<typeof setInterval>) => {
      intervals.delete(toId(timer as ReturnType<typeof setTimeout>));
    },
    setTimeout: (fn: () => void) => {
      const id = nextId++;
      timeouts.set(id, fn);
      return toHandle(id);
    },
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => {
      timeouts.delete(toId(timer));
    },
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("heartbeat-orchestrator", () => {
  it("requests-in-flight で skip された場合は retry timer を張る", async () => {
    const scheduler = createScheduler();
    const reasons: string[] = [];
    const sequence: HeartbeatRunResult[] = [
      { status: "skipped", reason: "requests-in-flight" },
      { status: "ran", durationMs: 1 },
    ];
    const orchestrator = new HeartbeatOrchestrator({
      intervalMs: 100,
      retryDelayMs: 50,
      runTick: async (reason) => {
        reasons.push(reason);
        return sequence.shift() ?? { status: "ran", durationMs: 1 };
      },
      setInterval: scheduler.setInterval as typeof setInterval,
      clearInterval: scheduler.clearInterval as typeof clearInterval,
      setTimeout: scheduler.setTimeout as typeof setTimeout,
      clearTimeout: scheduler.clearTimeout as typeof clearTimeout,
    });

    orchestrator.start();
    scheduler.fireInterval();
    await flushMicrotasks();
    assert.equal(scheduler.timeoutCount(), 1);

    scheduler.fireTimeout();
    await flushMicrotasks();
    assert.deepEqual(reasons, ["timer", "requests-in-flight-retry"]);
  });

  it("run 中の重複 tick は抑止される", async () => {
    const scheduler = createScheduler();
    const gate: { resolve?: () => void } = {};
    let runCount = 0;
    const orchestrator = new HeartbeatOrchestrator({
      intervalMs: 100,
      retryDelayMs: 50,
      runTick: async () => {
        runCount += 1;
        await new Promise<void>((resolve) => {
          gate.resolve = () => resolve();
        });
        return { status: "ran", durationMs: 1 };
      },
      setInterval: scheduler.setInterval as typeof setInterval,
      clearInterval: scheduler.clearInterval as typeof clearInterval,
      setTimeout: scheduler.setTimeout as typeof setTimeout,
      clearTimeout: scheduler.clearTimeout as typeof clearTimeout,
    });

    orchestrator.start();
    scheduler.fireInterval();
    scheduler.fireInterval();
    await flushMicrotasks();
    assert.equal(runCount, 1);

    assert.equal(typeof gate.resolve, "function");
    gate.resolve?.();
    await flushMicrotasks();
    scheduler.fireInterval();
    await flushMicrotasks();
    assert.equal(runCount, 2);
  });

  it("stop は interval/retry timer を解放する", async () => {
    const scheduler = createScheduler();
    const orchestrator = new HeartbeatOrchestrator({
      intervalMs: 100,
      retryDelayMs: 50,
      runTick: async () => ({ status: "skipped", reason: "requests-in-flight" }),
      setInterval: scheduler.setInterval as typeof setInterval,
      clearInterval: scheduler.clearInterval as typeof clearInterval,
      setTimeout: scheduler.setTimeout as typeof setTimeout,
      clearTimeout: scheduler.clearTimeout as typeof clearTimeout,
    });

    orchestrator.start();
    scheduler.fireInterval();
    await flushMicrotasks();
    assert.equal(scheduler.intervalCount(), 1);
    assert.equal(scheduler.timeoutCount(), 1);

    orchestrator.stop();
    assert.equal(scheduler.intervalCount(), 0);
    assert.equal(scheduler.timeoutCount(), 0);
  });
});
