import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import type { NormalizedEvent } from "../../../src/core/events.js";
import { normalizeAndDedupeSourceEvents } from "../../../src/collector-slack/source-normalizer.js";

type FixtureFile = {
  events: {
    post: NormalizedEvent;
    reaction: NormalizedEvent;
    notification: NormalizedEvent;
  };
};

const fixturePath = resolve(
  process.cwd(),
  "tests/fixtures/collector-slack/source-normalizer-fixtures.json"
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as FixtureFile;

test("fetch/websocket/response event stream normalizes and dedupes to unique slack events", () => {
  const stream = [
    { sourceKind: "fetch", payload: fixture.events.post },
    { sourceKind: "websocket", payload: fixture.events.post },
    { sourceKind: "websocket", payload: fixture.events.reaction },
    { sourceKind: "response", payload: fixture.events.notification },
    {
      sourceKind: "response",
      payload: {
        schema: "adjutant.event.v1.1",
        uid: "invalid-source",
        source: "github",
        kind: "push",
        ts: "2026-03-01T10:00:02.000Z",
      },
    },
  ] as const;

  const normalized = normalizeAndDedupeSourceEvents(stream);
  assert.equal(normalized.length, 3);
  assert.deepEqual(
    normalized.map((entry) => entry.sourceKind),
    ["fetch", "websocket", "response"]
  );
});

test("notification optional fields survive integration normalization", () => {
  const stream = [{ sourceKind: "response", payload: fixture.events.notification }] as const;

  const normalized = normalizeAndDedupeSourceEvents(stream);
  assert.equal(normalized.length, 1);
  const detail = normalized[0]?.event.detail;
  const slack = detail && "slack" in detail ? (detail.slack as Record<string, unknown>) : undefined;
  assert.equal(slack?.team_id, "T123");
  assert.equal(slack?.message_ts, "1730000000.456");
  assert.equal(slack?.thread_ts, "1730000000.400");
  assert.equal(slack?.mention_target_user_id, "U999");
  assert.equal(slack?.is_direct_mention, true);
});
