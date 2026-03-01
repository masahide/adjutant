import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SessionRecoveryStore } from "../../../../src/control-plane/acp/session-recovery-store.js";

test("SessionRecoveryStore persists and restores session recovery state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "adjutant-session-recovery-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const store = SessionRecoveryStore.fromStateDir(root);
  await store.initialize();

  await store.upsert({
    sessionKey: "main",
    sessionId: "sess_main_1",
  });
  await store.upsert({
    sessionKey: "main",
    sessionId: "sess_main_1",
    lastRunId: "session:sess_main_1:run:3",
  });

  const restored = SessionRecoveryStore.fromStateDir(root);
  await restored.initialize();

  const loaded = restored.get("main");
  assert.equal(loaded?.sessionId, "sess_main_1");
  assert.equal(loaded?.lastRunId, "session:sess_main_1:run:3");
});

test("SessionRecoveryStore upsert keeps previous lastRunId when omitted", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "adjutant-session-recovery-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const store = SessionRecoveryStore.fromStateDir(root);
  await store.initialize();

  await store.upsert({
    sessionKey: "main",
    sessionId: "sess_main_1",
    lastRunId: "session:sess_main_1:run:2",
  });
  await store.upsert({
    sessionKey: "main",
    sessionId: "sess_main_1",
  });

  const loaded = store.get("main");
  assert.equal(loaded?.lastRunId, "session:sess_main_1:run:2");
});

test("SessionRecoveryStore truncates corrupted tail and restores from last valid entry", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "adjutant-session-recovery-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const store = SessionRecoveryStore.fromStateDir(root);
  await store.initialize();
  await store.upsert({
    sessionKey: "main",
    sessionId: "sess_main_1",
    lastRunId: "session:sess_main_1:run:1",
  });

  const journalPath = join(root, "journal", "control-plane", "session-recovery.jsonl");
  await appendFile(journalPath, "{not-json}\n", "utf8");

  const restored = SessionRecoveryStore.fromStateDir(root);
  await restored.initialize();

  const loaded = restored.get("main");
  assert.equal(loaded?.sessionId, "sess_main_1");
  assert.equal(loaded?.lastRunId, "session:sess_main_1:run:1");

  const journalRaw = await readFile(journalPath, "utf8");
  assert.equal(journalRaw.includes("{not-json}"), false);
});

test("SessionRecoveryStore clamps non-monotonic updatedAt on upsert", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "adjutant-session-recovery-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const nowSequence = ["2026-03-01T10:00:05.000Z", "2026-03-01T10:00:01.000Z"];
  const warnings: Array<Record<string, unknown>> = [];
  const store = new SessionRecoveryStore({
    journalPath: join(root, "journal", "control-plane", "session-recovery.jsonl"),
    replayCursorPath: join(root, "cursor", "control-plane.session-recovery.replay-cursor.json"),
    snapshotPath: join(root, "cursor", "control-plane.session-recovery.snapshot.json"),
    now: () => nowSequence.shift() ?? "2026-03-01T10:00:05.000Z",
    onWarn: (message, meta) => warnings.push({ message, ...(meta ?? {}) }),
  });
  await store.initialize();

  await store.upsert({
    sessionKey: "main",
    sessionId: "sess_main_1",
    lastRunId: "session:sess_main_1:run:1",
  });
  await store.upsert({
    sessionKey: "main",
    sessionId: "sess_main_1",
    lastRunId: "session:sess_main_1:run:2",
  });

  const loaded = store.get("main");
  assert.equal(loaded?.updatedAt, "2026-03-01T10:00:05.000Z");
  assert.equal(
    warnings.some((entry) => entry.message === "session-recovery-updated-at-clamped"),
    true
  );
});

test("SessionRecoveryStore warns and skips duplicate replay records", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "adjutant-session-recovery-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const store = SessionRecoveryStore.fromStateDir(root);
  await store.initialize();
  await store.upsert({
    sessionKey: "main",
    sessionId: "sess_main_1",
    lastRunId: "session:sess_main_1:run:1",
  });

  const journalPath = join(root, "journal", "control-plane", "session-recovery.jsonl");
  const raw = await readFile(journalPath, "utf8");
  const firstLine = raw.split(/\r?\n/).find((line) => line.trim().length > 0);
  assert.ok(firstLine);
  await appendFile(journalPath, `${firstLine}\n`, "utf8");

  const warnings: Array<Record<string, unknown>> = [];
  const restored = SessionRecoveryStore.fromStateDir(root, {
    onWarn: (message, meta) => warnings.push({ message, ...(meta ?? {}) }),
  });
  await restored.initialize();

  const loaded = restored.get("main");
  assert.equal(loaded?.sessionId, "sess_main_1");
  assert.equal(
    warnings.some((entry) => entry.message === "session-recovery-duplicate-record"),
    true
  );
});
