import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { HEARTBEAT_RESULT_SCHEMA_V1 } from "../../../../src/control-plane/heartbeat/schema.js";
import { HeartbeatResultStore } from "../../../../src/control-plane/heartbeat/result-store.js";

test("HeartbeatResultStore: append / getLast / history cursor", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "adjutant-heartbeat-result-store-"));
  t.after(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  const store = HeartbeatResultStore.fromStateDir(stateDir);
  await store.initialize();
  assert.equal(store.getLast(), null);

  await store.append({
    schema: HEARTBEAT_RESULT_SCHEMA_V1,
    status: "ran",
    event: { status: "ok-token", reason: "ok-1" },
    ts: "2026-03-05T00:00:00.000Z",
    runId: "session:s1:run:1",
  });
  await store.append({
    schema: HEARTBEAT_RESULT_SCHEMA_V1,
    status: "failed",
    event: { status: "failed", reason: "boom" },
    ts: "2026-03-05T00:01:00.000Z",
  });

  const last = store.getLast();
  assert.equal(last?.status, "failed");
  assert.equal(last?.event.reason, "boom");

  const firstPage = store.list({ limit: 1 });
  assert.equal(firstPage.items.length, 1);
  assert.equal(firstPage.items[0]?.status, "failed");
  assert.equal(typeof firstPage.nextCursor, "string");

  const secondPage = store.list({ limit: 1, cursor: firstPage.nextCursor });
  assert.equal(secondPage.items.length, 1);
  assert.equal(secondPage.items[0]?.status, "ran");
  assert.equal(secondPage.nextCursor, undefined);
});

test("HeartbeatResultStore: invalid line は initialize で読み飛ばす", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "adjutant-heartbeat-result-store-"));
  t.after(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  const path = join(stateDir, "heartbeat-runs.jsonl");
  await writeFile(
    path,
    [
      JSON.stringify({
        schema: HEARTBEAT_RESULT_SCHEMA_V1,
        status: "ran",
        event: { status: "ok-empty" },
        ts: "2026-03-05T00:00:00.000Z",
      }),
      '{"broken":',
      JSON.stringify({
        schema: HEARTBEAT_RESULT_SCHEMA_V1,
        status: "invalid",
        event: { status: "ok-empty" },
        ts: "2026-03-05T00:00:10.000Z",
      }),
    ].join("\n"),
    "utf8"
  );

  const store = HeartbeatResultStore.fromStateDir(stateDir);
  await store.initialize();
  const history = store.list({ limit: 10 });
  assert.equal(history.items.length, 1);
  assert.equal(history.items[0]?.status, "ran");

  const raw = await readFile(path, "utf8");
  assert.equal(raw.includes("broken"), true);
});
