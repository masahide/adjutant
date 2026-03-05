import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AcceptedResponse } from "../../../src/control-plane/contracts/http-api.js";
import { IdempotencyStore } from "../../../src/control-plane/idempotency-store.js";

test("IdempotencyStore keeps command duplicate/conflict across restart", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "adjutant-idempotency-store-command-"));
  t.after(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  const accepted: AcceptedResponse = {
    messageId: "msg_command_1",
    status: "accepted",
    acceptedAt: "2026-03-04T00:00:00.000Z",
    runId: "session:sess_1:run:1",
  };

  const store1 = IdempotencyStore.fromStateDir(stateDir);
  await store1.initialize();
  await store1.bindCommand({
    sessionKey: "main",
    idempotencyKey: "dup_1",
    requestHash: '{"message":"hello"}',
    accepted,
  });

  const store2 = IdempotencyStore.fromStateDir(stateDir);
  await store2.initialize();
  const duplicate = store2.resolveCommand("main", "dup_1", '{"message":"hello"}');
  assert.equal(duplicate.kind, "duplicate");
  if (duplicate.kind === "duplicate") {
    assert.equal(duplicate.accepted.runId, accepted.runId);
  }
  const conflict = store2.resolveCommand("main", "dup_1", '{"message":"changed"}');
  assert.equal(conflict.kind, "conflict");
});

test("IdempotencyStore keeps ingest duplicate/conflict across restart", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "adjutant-idempotency-store-ingest-"));
  t.after(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  const store1 = IdempotencyStore.fromStateDir(stateDir);
  await store1.initialize();
  await store1.bindIngest({
    dedupeKey: "slack:C123@1730000000.123",
    payloadHash: "hash_a",
    canonicalMessageId: "msg_ingest_1",
  });

  const store2 = IdempotencyStore.fromStateDir(stateDir);
  await store2.initialize();
  const duplicate = store2.resolveIngest("slack:C123@1730000000.123", "hash_a");
  assert.equal(duplicate.kind, "duplicate");
  if (duplicate.kind === "duplicate") {
    assert.equal(duplicate.canonicalMessageId, "msg_ingest_1");
  }
  const conflict = store2.resolveIngest("slack:C123@1730000000.123", "hash_b");
  assert.equal(conflict.kind, "conflict");
});
