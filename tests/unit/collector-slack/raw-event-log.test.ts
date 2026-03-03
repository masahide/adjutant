import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RawEventLogWriter } from "../../../src/collector-slack/raw-event-log.js";

test("raw_fetch のみ jsonl へ追記する", async () => {
  const root = mkdtempSync(join(tmpdir(), "adjutant-raw-event-log-"));
  const filePath = join(root, "raw-fetch.jsonl");
  const logger = new RawEventLogWriter({ filePath });

  logger.record({
    source: "slack-adapter",
    kind: "raw_ws",
    at: "2026-03-03T00:00:00.000Z",
    payload: { ignored: true },
  });
  logger.record({
    source: "slack-adapter",
    kind: "raw_fetch",
    at: "2026-03-03T00:00:01.000Z",
    payload: { stage: "requestPaused", requestId: "req_1" },
  });
  await logger.flush();

  const line = readFileSync(filePath, "utf8").trim();
  const parsed = JSON.parse(line) as {
    schema?: string;
    source?: string;
    kind?: string;
    at?: string;
    payload?: { stage?: string; requestId?: string };
  };
  assert.equal(parsed.schema, "adjutant.raw-fetch.event.v1");
  assert.equal(parsed.source, "slack-adapter");
  assert.equal(parsed.kind, "raw_fetch");
  assert.equal(parsed.at, "2026-03-03T00:00:01.000Z");
  assert.equal(parsed.payload?.stage, "requestPaused");
  assert.equal(parsed.payload?.requestId, "req_1");
});

test("payload サイズ上限を超える場合は切り詰める", async () => {
  const root = mkdtempSync(join(tmpdir(), "adjutant-raw-event-log-"));
  const filePath = join(root, "raw-fetch.jsonl");
  const logger = new RawEventLogWriter({
    filePath,
    maxPayloadChars: 24,
  });

  logger.record({
    source: "slack-adapter",
    kind: "raw_fetch",
    at: "2026-03-03T00:00:00.000Z",
    payload: {
      text: "abcdefghijklmnopqrstuvwxyz",
    },
  });
  await logger.flush();

  const parsed = JSON.parse(readFileSync(filePath, "utf8").trim()) as {
    payload?: {
      _truncated?: boolean;
      original_length?: number;
      preview?: string;
    };
  };
  assert.equal(parsed.payload?._truncated, true);
  assert.ok((parsed.payload?.original_length ?? 0) > 24);
  assert.equal(parsed.payload?.preview?.length, 24);
});
