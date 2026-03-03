import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import type { CollectorIngestRequest } from "../../../../src/contracts/process-rpc/method-types.js";
import {
  projectCollectorIngestRequest,
  projectSlackPrompt,
  resolveSlackSessionKey,
} from "../../../../src/control-plane/process-rpc/ingest-projection.js";

type Fixture = {
  name: string;
  request: CollectorIngestRequest;
  expected: {
    sessionKey: string;
    message: string;
  };
};

const fixturesPath = resolve(
  process.cwd(),
  "tests/fixtures/collector-slack/ingest-projection-fixtures.json"
);
const fixtures = JSON.parse(readFileSync(fixturesPath, "utf8")) as Fixture[];

test("resolveSlackSessionKey / projectSlackPrompt fixtures", () => {
  assert.ok(fixtures.length > 0);

  for (const fixture of fixtures) {
    const event = fixture.request.payload;
    assert.equal(resolveSlackSessionKey(event), fixture.expected.sessionKey, fixture.name);
    assert.equal(projectSlackPrompt(event), fixture.expected.message, fixture.name);
  }
});

test("projectCollectorIngestRequest returns canonical projection", () => {
  const fixture = fixtures[0];
  assert.ok(fixture !== undefined);

  const projected = projectCollectorIngestRequest(fixture.request);
  assert.equal(projected.sessionKey, fixture.expected.sessionKey);
  assert.equal(projected.message, fixture.expected.message);
  assert.equal(projected.dedupeKey, fixture.request.dedupeKey);
  assert.equal(projected.source, "slack");
  assert.equal(projected.occurredAt, fixture.request.occurredAt);
  assert.deepEqual(projected.rawEvent, fixture.request.payload);
});
