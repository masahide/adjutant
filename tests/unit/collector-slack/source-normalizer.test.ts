import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import type { NormalizedEvent } from "../../../src/core/events.js";
import {
  normalizeAndDedupeSourceEvents,
  normalizeCollectorSourceEnvelope,
  SlackUidDeduper,
} from "../../../src/collector-slack/source-normalizer.js";

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

test("normalizeCollectorSourceEnvelope accepts normalized slack events from all source kinds", () => {
  const sourceKinds = ["fetch", "websocket", "response"] as const;
  for (const sourceKind of sourceKinds) {
    const envelope = normalizeCollectorSourceEnvelope({
      sourceKind,
      payload: fixture.events.post,
    });
    assert.ok(envelope);
    assert.equal(envelope.sourceKind, sourceKind);
    assert.equal(envelope.event.uid, fixture.events.post.uid);
  }
});

test("normalizeCollectorSourceEnvelope rejects malformed payload", () => {
  const envelope = normalizeCollectorSourceEnvelope({
    sourceKind: "fetch",
    payload: {
      uid: "missing-schema",
      source: "slack",
      kind: "post",
      ts: "2026-03-01T10:00:00.000Z",
    },
  });
  assert.equal(envelope, undefined);
});

test("SlackUidDeduper suppresses duplicate uid across source kinds", () => {
  const deduper = new SlackUidDeduper();
  assert.equal(deduper.shouldEmit(fixture.events.post), true);
  assert.equal(deduper.shouldEmit(fixture.events.post), false);

  const duplicateFromAnotherSource = {
    ...fixture.events.post,
    kind: "notification",
  } satisfies NormalizedEvent;
  assert.equal(deduper.shouldEmit(duplicateFromAnotherSource), false);
  assert.equal(deduper.size(), 1);
});

test("normalizeAndDedupeSourceEvents keeps first event per uid", () => {
  const inputs = [
    { sourceKind: "fetch", payload: fixture.events.post },
    { sourceKind: "websocket", payload: fixture.events.reaction },
    { sourceKind: "response", payload: fixture.events.notification },
    { sourceKind: "response", payload: fixture.events.post },
    { sourceKind: "fetch", payload: { invalid: true } },
  ] as const;

  const output = normalizeAndDedupeSourceEvents(inputs);

  assert.equal(output.length, 3);
  assert.deepEqual(
    output.map((entry) => entry.event.uid),
    [fixture.events.post.uid, fixture.events.reaction.uid, fixture.events.notification.uid]
  );
});
