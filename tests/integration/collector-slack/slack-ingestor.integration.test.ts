import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import type { NormalizedEvent } from "../../../src/core/events.js";
import { JsonlWriter } from "../../../src/collector-slack/jsonl-writer.js";
import { SlackAdapter } from "../../../src/collector-slack/slack-adapter.js";
import { SlackIngestor } from "../../../src/collector-slack/slack-ingestor.js";

type FixtureFile = {
  events: {
    post: NormalizedEvent;
  };
};

const fixturePath = resolve(
  process.cwd(),
  "tests/fixtures/collector-slack/source-normalizer-fixtures.json"
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as FixtureFile;

test("mock source input -> normalized event -> JSONL 保存の縦切り", async () => {
  const root = mkdtempSync(join(tmpdir(), "adjutant-slack-ingestor-integ-"));
  const adapter = new SlackAdapter();
  const writer = new JsonlWriter({
    dataDir: root,
    defaultAccountId: "default",
    now: () => new Date("2026-03-01T00:00:00.000Z"),
  });
  const received: string[] = [];
  const ingestor = new SlackIngestor({
    adapter,
    writer,
    onEvent: async (event) => {
      received.push(event.uid);
    },
  });

  await ingestor.start();
  await adapter.ingestSources([
    { sourceKind: "fetch", payload: fixture.events.post },
    { sourceKind: "websocket", payload: fixture.events.post },
  ]);
  await ingestor.stop();

  const filePath = join(root, "accounts", "default", "2026", "03", "01", "slack", "events.jsonl");
  const lines = readFileSync(filePath, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]) as { uid?: string; checksum?: string };
  assert.equal(parsed.uid, fixture.events.post.uid);
  assert.equal(typeof parsed.checksum, "string");
  assert.deepEqual(received, [fixture.events.post.uid]);
});
