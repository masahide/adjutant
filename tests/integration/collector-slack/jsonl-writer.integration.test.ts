import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { NormalizedEvent } from "../../../src/core/events.js";
import { JsonlWriter } from "../../../src/collector-slack/jsonl-writer.js";

function baseEvent(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    schema: "adjutant.event.v1.1",
    uid: overrides.uid ?? "slack:C123@1730000000.123",
    source: overrides.source ?? "slack",
    kind: overrides.kind ?? "post",
    ts: overrides.ts ?? "2026-03-01T10:00:00.000Z",
    logged_at: overrides.logged_at ?? "2026-03-01T10:00:00.000Z",
    meta: overrides.meta ?? { account_id: "default" },
    detail: overrides.detail ?? {
      slack: {
        channel_id: "C123",
        message_ts: "1730000000.123",
        text: "hello",
      },
    },
  };
}

test("date/source 単位に JSONL が分割され、同一ファイルへは append される", async () => {
  const root = mkdtempSync(join(tmpdir(), "adjutant-jsonl-writer-integ-"));
  const writer = new JsonlWriter({ dataDir: root, defaultAccountId: "default" });

  await writer.append(baseEvent({ uid: "slack:C123@1", logged_at: "2026-03-02T00:00:00.000Z" }));
  await writer.append(baseEvent({ uid: "slack:C123@2", logged_at: "2026-03-02T01:00:00.000Z" }));
  await writer.append(
    baseEvent({ uid: "github:repo@1", source: "github", logged_at: "2026-03-02T02:00:00.000Z" })
  );
  await writer.append(baseEvent({ uid: "slack:C123@3", logged_at: "2026-03-03T00:00:00.000Z" }));

  const slackDay1 = join(root, "accounts", "default", "2026", "03", "02", "slack", "events.jsonl");
  const githubDay1 = join(
    root,
    "accounts",
    "default",
    "2026",
    "03",
    "02",
    "github",
    "events.jsonl"
  );
  const slackDay2 = join(root, "accounts", "default", "2026", "03", "03", "slack", "events.jsonl");

  const slackDay1Lines = readFileSync(slackDay1, "utf8").trim().split("\n");
  const githubDay1Lines = readFileSync(githubDay1, "utf8").trim().split("\n");
  const slackDay2Lines = readFileSync(slackDay2, "utf8").trim().split("\n");

  assert.equal(slackDay1Lines.length, 2);
  assert.equal(githubDay1Lines.length, 1);
  assert.equal(slackDay2Lines.length, 1);
});
