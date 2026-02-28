import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SlackAdapter } from "../src/slack/adapter.js";
import type { NormalizedEvent } from "../src/core/events.js";
import { createMockSlackClient } from "./mockSlackClient.js";

describe("SlackAdapter contract", () => {
  it("start() enables Fetch/Networkとemitシーケンスを構築する", async () => {
    const mock = createMockSlackClient();
    const emitted: NormalizedEvent[] = [];
    const adapter = new SlackAdapter({
      client: mock.client,
      now: () => new Date("2024-03-22T12:00:00Z"),
    });

    await adapter.start(async (ev) => {
      emitted.push(ev);
    });

    assert.ok(
      mock.calls.some((c) => c.startsWith("Network.enable")),
      "Network.enableが呼ばれる"
    );
    assert.ok(
      mock.calls.some((c) => c.startsWith("Network.setCacheDisabled")),
      "Network.setCacheDisabledが呼ばれる"
    );
    assert.ok(
      mock.calls.some((c) => c.startsWith("Fetch.enable")),
      "Fetch.enableが呼ばれる"
    );

    await mock.triggerFetch({
      requestId: "req-1",
      request: {
        url: "https://example.slack.com/api/chat.postMessage",
        method: "POST",
        headers: { "content-type": "application/json" },
        postData: JSON.stringify({
          channel: "C123",
          text: "contract message",
          user: "U123",
          ts: "1711111111.000200",
        }),
      },
    });

    assert.equal(emitted.length, 1, "emitが1回呼ばれる");
    assert.equal(mock.continued[0], "req-1", "Fetch.continueRequestが呼ばれる");
  });
});
