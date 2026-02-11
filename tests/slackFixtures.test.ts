import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { normalizeSlackMessage, normalizeSlackReaction } from "../src/slack/normalize.js";

const fixturesDir = join(process.cwd(), "tests", "fixtures", "slack");

const load = async (name: string) => {
  const content = await readFile(join(fixturesDir, name), "utf8");
  return JSON.parse(content);
};

describe("Slack fixtures", () => {
  it("post-message", async () => {
    const fixture = await load("post-message.json");
    const event = normalizeSlackMessage(fixture.payload, {
      now: new Date("2024-03-22T12:40:00Z"),
    });
    assert.equal(event.uid, fixture.expected.uid);
    assert.equal(event.meta?.channel, fixture.expected.meta.channel);
  });

  it("thread-message", async () => {
    const fixture = await load("thread-message.json");
    const event = normalizeSlackMessage(fixture.payload, {
      now: new Date("2024-03-22T12:40:00Z"),
    });
    assert.equal(event.uid, fixture.expected.uid);
    const detail = event.detail;
    assert.ok(detail && "slack" in detail);
    const slackDetail = detail.slack as { thread_ts?: string };
    assert.equal(slackDetail.thread_ts, fixture.expected.detail.slack.thread_ts);
  });

  it("reaction-add", async () => {
    const fixture = await load("reaction-add.json");
    const event = normalizeSlackReaction(fixture.payload, {
      now: new Date("2024-03-22T12:40:00Z"),
    });
    assert.equal(event.uid, fixture.expected.uid);
    assert.equal(event.meta?.emoji, fixture.expected.meta.emoji);
  });
});
