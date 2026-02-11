import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SlackAdapter } from "../src/slack/adapter.js";
import type { NormalizedEvent } from "../src/core/events.js";
import { createMockSlackClient } from "./mockSlackClient.js";

describe("SlackAdapter + JsonlWriter integration", () => {
  it("emit 経由で writer.append が呼ばれる", async () => {
    const mock = createMockSlackClient();
    const adapter = new SlackAdapter({
      client: mock.client,
      now: () => new Date("2024-03-22T12:45:00Z"),
    });

    const appendCalls: NormalizedEvent[] = [];
    const fakeWriter = {
      append: async (event: NormalizedEvent) => {
        appendCalls.push(event);
      },
    };

    await adapter.start(async (event) => {
      await fakeWriter.append(event);
    });

    await mock.triggerFetch({
      requestId: "req-1",
      request: {
        url: "https://workspace.slack.com/api/chat.postMessage",
        method: "POST",
        headers: { "content-type": "application/json" },
        postData: JSON.stringify({
          channel: "C123",
          text: "integration",
          user: "U_TEST",
          ts: "1711117777.000888",
        }),
      },
    });

    assert.equal(appendCalls.length, 1);
    assert.equal(appendCalls[0].uid, "slack:C123@1711117777.000888");
  });
});
