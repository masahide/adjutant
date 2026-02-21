import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HeartbeatExecution } from "../../src/assistant/heartbeat-execution.js";

describe("heartbeat-execution", () => {
  it("timeout 以内で完了すれば値を返す", async () => {
    const execution = new HeartbeatExecution({
      setTimeout,
      clearTimeout,
    });
    const result = await execution.runWithTimeout(50, async () => "ok");
    assert.equal(result, "ok");
  });

  it("timeout 超過時は例外にする", async () => {
    const execution = new HeartbeatExecution({
      setTimeout,
      clearTimeout,
    });
    await assert.rejects(
      execution.runWithTimeout(10, async () => await new Promise(() => undefined)),
      /timeout/i
    );
  });
});
