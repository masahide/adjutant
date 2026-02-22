import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PRIORITY_MAX,
  createGlobalConcurrencyQueue,
} from "../../src/proactive/global-concurrency-queue.js";

describe("global-concurrency-queue", () => {
  it("maxConcurrent 超過時に DM burst slot で 4 並行を許可する", async () => {
    const queue = createGlobalConcurrencyQueue({
      maxConcurrent: 3,
      dmBurstSlot: 1,
      maxRunningDM: 3,
    });

    const a = await queue.acquire({ source: "channel" });
    const b = await queue.acquire({ source: "channel" });
    const c = await queue.acquire({ source: "dm" });
    assert.equal(queue.getSnapshot().running, 3);

    const d = await queue.acquire({ source: "dm" });
    assert.equal(queue.getSnapshot().running, 4);

    d.release();
    c.release();
    b.release();
    a.release();
    assert.equal(queue.getSnapshot().running, 0);
  });

  it("非DM待ちがある場合は maxRunningDM で DM を抑制し非DM枠を保証する", async () => {
    const queue = createGlobalConcurrencyQueue({
      maxConcurrent: 3,
      dmBurstSlot: 1,
      maxRunningDM: 3,
    });

    const dm1 = await queue.acquire({ source: "dm" });
    const dm2 = await queue.acquire({ source: "dm" });
    const dm3 = await queue.acquire({ source: "dm" });
    assert.equal(queue.getSnapshot().dmRunning, 3);

    const channelPromise = queue.acquire({ source: "channel" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(queue.getSnapshot().waiting, 1);

    dm1.release();
    const channelLease = await channelPromise;
    assert.equal(channelLease.source, "channel");
    const dm4 = await queue.acquire({ source: "dm" });
    assert.equal(dm4.source, "dm");
    assert.equal(queue.getSnapshot().running, 4);
    assert.equal(queue.getSnapshot().dmRunning, 3);

    const dm5Promise = queue.acquire({ source: "dm" });
    let dm4Resolved = false;
    void dm5Promise.then(() => {
      dm4Resolved = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(dm4Resolved, false);

    dm4.release();
    dm3.release();
    channelLease.release();
    dm2.release();
    const dm5 = await dm5Promise;
    assert.equal(dm5.source, "dm");
    dm5.release();
  });

  it("non-DM 待ちがない場合は work-conserving で DM が全枠を使える", async () => {
    const queue = createGlobalConcurrencyQueue({
      maxConcurrent: 3,
      dmBurstSlot: 1,
      maxRunningDM: 3,
    });

    const leases = await Promise.all([
      queue.acquire({ source: "dm" }),
      queue.acquire({ source: "dm" }),
      queue.acquire({ source: "dm" }),
      queue.acquire({ source: "dm" }),
    ]);
    assert.equal(queue.getSnapshot().running, 4);
    assert.equal(queue.getSnapshot().dmRunning, 4);
    for (const lease of leases) {
      lease.release();
    }
  });

  it("aging で starvation 超過エントリは PRIORITY_MAX で昇格する", async () => {
    let now = 0;
    const queue = createGlobalConcurrencyQueue({
      maxConcurrent: 1,
      dmBurstSlot: 0,
      maxRunningDM: 1,
      starvationMs: 50,
      nowMs: () => now,
    });

    const dm = await queue.acquire({ source: "dm" });
    const channelPromise = queue.acquire({ source: "channel" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    now = 60;
    const dmLaterPromise = queue.acquire({ source: "dm" });

    dm.release();
    const first = await channelPromise;
    assert.equal(first.source, "channel");
    first.release();
    const second = await dmLaterPromise;
    assert.equal(second.source, "dm");
    second.release();
    assert.equal(PRIORITY_MAX > 900, true);
  });
});
