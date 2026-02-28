import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SlackAdapter } from "../../src/slack/adapter.js";
import { createMockSlackClient } from "../mockSlackClient.js";

describe("SlackAdapter runtime context integration", () => {
  it("Runtime context 作成イベントを元に evaluate contextId 順序を維持する", async () => {
    const mock = createMockSlackClient();
    const evaluateCalls: Array<{ contextId?: number; expression?: string }> = [];

    mock.setRuntimeEvaluate(async (params) => {
      evaluateCalls.push(params);
      return { result: { value: { status: "no-target" } } };
    });

    const adapter = new SlackAdapter({
      client: mock.client,
      now: () => new Date("2024-03-22T12:45:00Z"),
    });

    await adapter.start(async () => {});

    mock.triggerExecutionContextCreated({
      context: {
        id: 31,
        name: "default-main",
        auxData: { frameId: "F_MAIN", type: "default" },
      },
    });
    mock.triggerExecutionContextCreated({
      context: {
        id: 32,
        name: "isolated-main",
        auxData: { frameId: "F_MAIN", type: "isolated" },
      },
    });
    mock.triggerExecutionContextCreated({
      context: {
        id: 33,
        name: "other-main",
        auxData: { frameId: "F_MAIN", type: "worker" },
      },
    });
    mock.triggerExecutionContextCreated({
      context: {
        id: 99,
        name: "default-fallback",
        auxData: { type: "default" },
      },
    });

    await mock.triggerFetch({
      requestId: "req-runtime-1",
      frameId: "F_MAIN",
      request: {
        url: "https://example.slack.com/api/reactions.add",
        method: "POST",
        headers: { "content-type": "application/json" },
        postData: JSON.stringify({
          channel: "C123",
          timestamp: "1711112222.000300",
          name: "eyes",
          user: "U_TEST",
        }),
      },
    });

    const firstCycle = evaluateCalls.slice(0, 5).map((call) => call.contextId);
    assert.deepEqual(firstCycle, [31, 32, 33, 99, undefined]);
    assert.ok(
      evaluateCalls.some((call) => call.expression?.includes("1711112222.000300")),
      "DOMキャプチャ式が実行される"
    );

    await adapter.stop();
  });
});
