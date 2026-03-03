import assert from "node:assert/strict";
import test from "node:test";

import { CollectorSlackMain, computeFullJitterDelayMs } from "../../../src/collector-slack/main.js";

test("computeFullJitterDelayMs は full jitter 範囲内の値を返す", () => {
  const d1 = computeFullJitterDelayMs(1, () => 0.0);
  const d2 = computeFullJitterDelayMs(1, () => 0.9999);
  const d5 = computeFullJitterDelayMs(5, () => 0.5);
  const dMax = computeFullJitterDelayMs(99, () => 0.75);

  assert.equal(d1, 0);
  assert.ok(d2 < 1_000);
  assert.ok(d5 >= 0 && d5 < 10_000);
  assert.ok(dMax >= 0 && dMax < 10_000);
});

test("CollectorSlackMain は接続失敗後に再接続を試行する", async () => {
  const sleeps: number[] = [];
  let connectCalls = 0;
  let resolveClose: (() => void) | null = null;
  const closed = new Promise<void>((resolve) => {
    resolveClose = resolve;
  });

  const main = new CollectorSlackMain({
    connect: async () => {
      connectCalls += 1;
      if (connectCalls === 1) {
        throw new Error("first connect failed");
      }
      return {
        waitClosed: async () => closed,
        close: async () => {
          resolveClose?.();
        },
      };
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
  });

  await main.start();
  await Promise.resolve();
  await Promise.resolve();
  await main.stop();

  assert.ok(connectCalls >= 2);
  assert.equal(sleeps.length, 1);
  assert.equal(sleeps[0], 500);
});

test("CollectorSlackMain.stop は active connection を close する", async () => {
  let closeCalled = 0;
  let resolveClose: (() => void) | null = null;
  const closed = new Promise<void>((resolve) => {
    resolveClose = resolve;
  });

  const main = new CollectorSlackMain({
    connect: async () => ({
      waitClosed: async () => closed,
      close: async () => {
        closeCalled += 1;
        resolveClose?.();
      },
    }),
    sleep: async () => {},
  });

  await main.start();
  await Promise.resolve();
  await main.stop();

  assert.equal(closeCalled, 1);
});
