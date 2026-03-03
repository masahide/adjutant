import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RawEventLogWriter } from "../../../src/collector-slack/raw-event-log.js";

test("連続 record した raw_fetch が append-only で記録される", async () => {
  const root = mkdtempSync(join(tmpdir(), "adjutant-raw-event-log-integ-"));
  const filePath = join(root, "_debug", "raw-fetch.jsonl");
  const logger = new RawEventLogWriter({ filePath });

  logger.record({
    source: "slack-adapter",
    kind: "raw_fetch",
    at: "2026-03-03T00:00:00.000Z",
    payload: { seq: 1 },
  });
  logger.record({
    source: "slack-adapter",
    kind: "raw_fetch",
    at: "2026-03-03T00:00:01.000Z",
    payload: { seq: 2 },
  });
  await logger.flush();

  const lines = readFileSync(filePath, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  const first = JSON.parse(lines[0]) as { payload?: { seq?: number } };
  const second = JSON.parse(lines[1]) as { payload?: { seq?: number } };
  assert.equal(first.payload?.seq, 1);
  assert.equal(second.payload?.seq, 2);
});
