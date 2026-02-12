import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { RawFetchEventFileLogger } from "../src/io/rawFetchEventFileLogger.js";

describe("RawFetchEventFileLogger", () => {
  it("raw_fetchのみjsonlへ追記する", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "adjutant-raw-fetch-log-"));
    const logPath = join(tempDir, "raw-fetch.jsonl");
    const logger = new RawFetchEventFileLogger({ filePath: logPath });

    logger.record({
      source: "slack-adapter",
      kind: "raw_ws",
      at: "2026-02-12T00:00:00.000Z",
      payload: { type: "message" },
    });
    logger.record({
      source: "slack-adapter",
      kind: "raw_fetch",
      at: "2026-02-12T00:00:01.000Z",
      payload: { stage: "responseReceived", requestId: "req-1" },
    });
    await logger.flush();

    const content = await readFile(logPath, "utf8");
    const lines = content.trim().split("\n");
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]) as {
      schema?: string;
      source?: string;
      kind?: string;
      at?: string;
      payload?: { stage?: string; requestId?: string };
    };
    assert.equal(parsed.schema, "adjutant.raw-fetch.event.v1");
    assert.equal(parsed.source, "slack-adapter");
    assert.equal(parsed.kind, "raw_fetch");
    assert.equal(parsed.at, "2026-02-12T00:00:01.000Z");
    assert.equal(parsed.payload?.stage, "responseReceived");
    assert.equal(parsed.payload?.requestId, "req-1");

    await rm(tempDir, { recursive: true, force: true });
  });

  it("payload上限を超える場合は切り詰める", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "adjutant-raw-fetch-log-"));
    const logPath = join(tempDir, "raw-fetch.jsonl");
    const logger = new RawFetchEventFileLogger({
      filePath: logPath,
      maxPayloadChars: 24,
    });

    logger.record({
      source: "slack-adapter",
      kind: "raw_fetch",
      at: "2026-02-12T00:00:01.000Z",
      payload: {
        text: "abcdefghijklmnopqrstuvwxyz",
      },
    });
    await logger.flush();

    const content = await readFile(logPath, "utf8");
    const parsed = JSON.parse(content.trim()) as {
      payload?: { _truncated?: boolean; original_length?: number; preview?: string };
    };
    assert.equal(parsed.payload?._truncated, true);
    assert.ok((parsed.payload?.original_length ?? 0) > 24);
    assert.equal(parsed.payload?.preview?.length, 24);

    await rm(tempDir, { recursive: true, force: true });
  });
});
