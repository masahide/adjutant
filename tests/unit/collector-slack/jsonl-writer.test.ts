import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { NormalizedEvent } from "../../../src/core/events.js";
import { computeJsonlChecksum } from "../../../src/collector-slack/jsonl-checksum.js";
import { JsonlWriter } from "../../../src/collector-slack/jsonl-writer.js";

function createEvent(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    schema: "adjutant.event.v1.1",
    uid: overrides.uid ?? "slack:C123@1730000000.123",
    source: overrides.source ?? "slack",
    kind: overrides.kind ?? "post",
    ts: overrides.ts ?? "2026-03-01T10:00:00.000Z",
    logged_at: overrides.logged_at ?? "2026-03-01T10:00:00.000Z",
    meta: overrides.meta ?? {},
    detail: overrides.detail ?? {
      slack: {
        channel_id: "C123",
        message_ts: "1730000000.123",
        text: "hello",
      },
    },
  };
}

test("account/date/source path に events.jsonl を追記し checksum を付与する", async () => {
  const root = mkdtempSync(join(tmpdir(), "adjutant-jsonl-writer-"));
  const writer = new JsonlWriter({ dataDir: root, defaultAccountId: "default" });

  const event = createEvent({
    logged_at: "2026-03-02T09:10:11.000Z",
    meta: { account_id: "work" },
  });
  await writer.append(event);

  const filePath = join(root, "accounts", "work", "2026", "03", "02", "slack", "events.jsonl");
  const line = readFileSync(filePath, "utf8").trim();
  const parsed = JSON.parse(line) as Record<string, unknown>;

  assert.equal(parsed.uid, event.uid);
  assert.equal((parsed.meta as { account_id?: string }).account_id, "work");
  assert.equal(typeof parsed.checksum, "string");
  const payloadForHash = { ...parsed };
  delete (payloadForHash as { checksum?: unknown }).checksum;
  assert.equal(parsed.checksum, computeJsonlChecksum(payloadForHash));
});

test("logged_at/meta.account_id が無い場合は補完される", async () => {
  const root = mkdtempSync(join(tmpdir(), "adjutant-jsonl-writer-"));
  const fixedNow = new Date("2026-03-03T01:02:03.000Z");
  const writer = new JsonlWriter({
    dataDir: root,
    defaultAccountId: "fallback",
    now: () => fixedNow,
  });

  const event = createEvent({
    logged_at: "",
    meta: {},
  });
  await writer.append(event);

  const filePath = join(root, "accounts", "fallback", "2026", "03", "03", "slack", "events.jsonl");
  const parsed = JSON.parse(readFileSync(filePath, "utf8").trim()) as {
    logged_at?: string;
    meta?: { account_id?: string };
  };

  assert.equal(parsed.logged_at, fixedNow.toISOString());
  assert.equal(parsed.meta?.account_id, "fallback");
});

test("append ENOENT 時は再試行して成功できる", async () => {
  const calls: string[] = [];
  const writer = new JsonlWriter({
    dataDir: "/tmp/adjutant-writer-test",
    fileOps: {
      mkdir: async (path) => {
        calls.push(`mkdir:${path}`);
      },
      appendFile: async () => {
        const appendCalls = calls.filter((entry) => entry.startsWith("append")).length;
        calls.push("append");
        if (appendCalls === 0) {
          const error = new Error("ENOENT") as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        }
      },
    },
  });

  await writer.append(createEvent());
  assert.ok(calls.filter((entry) => entry === "append").length >= 2);
});
