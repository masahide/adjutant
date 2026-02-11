import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SlackAdapter } from "../../src/slack/adapter.js";
import { createMockSlackClient } from "../mockSlackClient.js";

const TEST_USER_ID = "U_TEST";
const OTHER_USER_ID = "U_OTHER";

describe("SlackAdapter reactions DOM capture", () => {
  it("Fetch経由のreactions APIでDOMキャプチャを試みる", async () => {
    const mock = createMockSlackClient();
    const evaluateCalls: Array<{ expression?: string }> = [];

    mock.setRuntimeEvaluate(async (params) => {
      evaluateCalls.push(params);
      return { result: { value: { status: "no-target" } } };
    });

    const adapter = new SlackAdapter({
      client: mock.client,
      now: () => new Date("2024-03-22T12:45:00Z"),
    });

    await adapter.start(async () => {});

    await mock.triggerFetch({
      requestId: "req-fetch-1",
      request: {
        url: "https://example.slack.com/api/reactions.add",
        method: "POST",
        headers: { "content-type": "application/json" },
        postData: JSON.stringify({
          channel: "C123",
          timestamp: "1711112222.000300",
          name: "eyes",
          user: TEST_USER_ID,
        }),
      },
    });

    assert.ok(
      evaluateCalls.some((call) => call.expression?.includes("1711112222.000300")),
      "DOMキャプチャ用のRuntime.evaluateが呼ばれる"
    );

    await adapter.stop();
  });

  it("WebSocket経由の他ユーザーリアクションではDOMキャプチャを避けたい", async () => {
    const mock = createMockSlackClient();
    const evaluateCalls: Array<{ expression?: string }> = [];

    mock.setRuntimeEvaluate(async (params) => {
      evaluateCalls.push(params);
      return { result: { value: { status: "no-target" } } };
    });

    const adapter = new SlackAdapter({
      client: mock.client,
      now: () => new Date("2024-03-22T12:45:00Z"),
    });

    await adapter.start(async () => {});

    const reactionPayload = {
      type: "reaction_added",
      user: OTHER_USER_ID,
      reaction: "eyes",
      item: {
        type: "message",
        channel: "C123",
        ts: "1711113333.000400",
      },
    };

    await mock.triggerNetwork("webSocketFrameReceived", {
      response: {
        payloadData: JSON.stringify(reactionPayload),
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(
      evaluateCalls.length,
      0,
      "他ユーザーのリアクションではDOMキャプチャを行わない想定"
    );

    await adapter.stop();
  });
});
