import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HeartbeatPrecheck } from "../../src/assistant/heartbeat-precheck.js";

describe("heartbeat-precheck", () => {
  it("最初にヒットした skip 結果を返す", async () => {
    const calls: string[] = [];
    const precheck = new HeartbeatPrecheck([
      async () => {
        calls.push("first");
        return null;
      },
      async () => {
        calls.push("second");
        return { status: "skipped", reason: "requests-in-flight" };
      },
      async () => {
        calls.push("third");
        return { status: "skipped", reason: "quiet-hours" };
      },
    ]);

    const result = await precheck.evaluate();
    assert.deepEqual(calls, ["first", "second"]);
    assert.deepEqual(result, { status: "skipped", reason: "requests-in-flight" });
  });
});
