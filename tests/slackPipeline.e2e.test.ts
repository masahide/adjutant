import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SlackAdapter } from "../src/slack/adapter.js";
import { JsonlWriter } from "../src/io/jsonlWriter.js";
import { SlackIngestor } from "../src/pipeline/slackIngestor.js";
import { createMockSlackClient } from "./mockSlackClient.js";

describe("SlackIngestor end-to-end", () => {
  it("Slackイベントをevents.jsonlに書き出す", async () => {
    const tmp = await mkdtemp(`${tmpdir()}/reaclog-e2e-`);
    const writer = new JsonlWriter({ dataDir: tmp });
    const mock = createMockSlackClient();
    const adapter = new SlackAdapter({
      client: mock.client,
      now: () => new Date("2024-03-22T12:40:00Z"),
    });

    const ingestor = new SlackIngestor({ adapter, writer });
    await ingestor.start();

    await mock.triggerFetch({
      requestId: "req-1",
      request: {
        url: "https://workspace.slack.com/api/chat.postMessage",
        method: "POST",
        headers: { "content-type": "application/json" },
        postData: JSON.stringify({
          channel: "C123",
          text: "end-to-end message",
          user: "U123",
          ts: "1711119999.001000",
        }),
      },
    });

    const [year] = await readdir(tmp);
    const [month] = await readdir(join(tmp, year));
    const [day] = await readdir(join(tmp, year, month));
    const targetPath = join(tmp, year, month, day, "slack", "events.jsonl");
    const content = await readFile(targetPath, "utf8");
    const lines = content.trim().split("\n");
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).detail.slack.text, "end-to-end message");

    await ingestor.stop();
    await rm(tmp, { recursive: true, force: true });
  });
});
