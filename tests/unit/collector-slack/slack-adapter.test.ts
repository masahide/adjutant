import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import type { NormalizedEvent } from "../../../src/core/events.js";
import { SlackAdapter } from "../../../src/collector-slack/slack-adapter.js";

type FixtureFile = {
  events: {
    post: NormalizedEvent;
    reaction: NormalizedEvent;
  };
};

const fixturePath = resolve(
  process.cwd(),
  "tests/fixtures/collector-slack/source-normalizer-fixtures.json"
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as FixtureFile;

test("SlackAdapter は start 後に source を emit し、uid 重複を抑止する", async () => {
  const adapter = new SlackAdapter();
  const uids: string[] = [];
  await adapter.start(async (event) => {
    uids.push(event.uid);
  });

  await adapter.ingestSources([
    { sourceKind: "fetch", payload: fixture.events.post },
    { sourceKind: "websocket", payload: fixture.events.post },
    { sourceKind: "response", payload: fixture.events.reaction },
  ]);

  assert.deepEqual(uids, [fixture.events.post.uid, fixture.events.reaction.uid]);
});

test("SlackAdapter は stop 後に emit しない", async () => {
  const adapter = new SlackAdapter();
  let count = 0;
  await adapter.start(() => {
    count += 1;
  });
  await adapter.stop();
  await adapter.ingestSource({
    sourceKind: "fetch",
    payload: fixture.events.post,
  });
  assert.equal(count, 0);
});
