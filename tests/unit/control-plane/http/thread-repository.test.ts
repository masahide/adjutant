import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ThreadRepository } from "../../../../src/control-plane/http/thread-repository.js";

function createThreadRepository(stateDir: string, options?: { now?: () => string }) {
  return new ThreadRepository({
    journalPath: join(stateDir, "journal", "control-plane", "threads.jsonl"),
    replayCursorPath: join(stateDir, "cursor", "control-plane.threads.replay-cursor.json"),
    snapshotPath: join(stateDir, "cursor", "control-plane.threads.snapshot.json"),
    now: options?.now,
    newThreadId: () => "thr_fixed_id",
  });
}

test("ThreadRepository は main 仮想エントリを返し、memoryScope を解決できる", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "adjutant-thread-repo-"));
  t.after(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  const repository = createThreadRepository(stateDir);
  await repository.initialize();

  const main = repository.getOrVirtual("main");
  assert.ok(main);
  assert.equal(main.threadId, "main");
  assert.equal(main.isDefault, true);
  assert.equal(main.createdAt, "1970-01-01T00:00:00.000Z");
  assert.equal(repository.resolveMemoryScope("main"), "main");
  assert.equal(repository.resolveMemoryScope("thr_x"), "spoke");

  const list = repository.list();
  assert.equal(list[0]?.threadId, "main");
});

test("ThreadRepository は main を遅延実体化し、再起動後も復元できる", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "adjutant-thread-repo-main-"));
  t.after(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  const now = () => "2026-03-01T12:00:00.000Z";
  const repository = createThreadRepository(stateDir, { now });
  await repository.initialize();

  const materialized = await repository.ensureForSessionKey("main");
  assert.equal(materialized.threadId, "main");
  assert.equal(materialized.createdAt, "2026-03-01T12:00:00.000Z");
  assert.equal(materialized.updatedAt, "2026-03-01T12:00:00.000Z");

  const restored = createThreadRepository(stateDir, { now });
  await restored.initialize();
  const restoredMain = restored.get("main");
  assert.ok(restoredMain);
  assert.equal(restoredMain.title, "Main");
  assert.equal(restoredMain.createdAt, "2026-03-01T12:00:00.000Z");
});

test("ThreadRepository は delete tombstone を replay して削除済み thread を復元しない", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "adjutant-thread-repo-delete-"));
  t.after(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  let tick = 0;
  const repository = createThreadRepository(stateDir, {
    now: () => `2026-03-01T12:00:0${tick++}.000Z`,
  });
  await repository.initialize();

  const created = await repository.create({ title: "Thread-A" });
  assert.equal(created.threadId, "thr_fixed_id");
  const deleted = await repository.delete(created.threadId);
  assert.equal(deleted, true);

  const journalPath = join(stateDir, "journal", "control-plane", "threads.jsonl");
  const journalRaw = await readFile(journalPath, "utf8");
  assert.equal(journalRaw.includes('"op":"delete"'), true);

  const restored = createThreadRepository(stateDir);
  await restored.initialize();
  assert.equal(restored.get(created.threadId), undefined);
  assert.equal(restored.list().length, 1);
  assert.equal(restored.list()[0]?.threadId, "main");
});

test("ThreadRepository.update は title/archived 更新を反映する", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "adjutant-thread-repo-update-"));
  t.after(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  const repository = createThreadRepository(stateDir, {
    now: () => "2026-03-01T12:00:00.000Z",
  });
  await repository.initialize();

  const mainUpdated = await repository.update("main", {
    title: "Primary",
    archived: true,
  });
  assert.ok(mainUpdated);
  assert.equal(mainUpdated.threadId, "main");
  assert.equal(mainUpdated.title, "Primary");
  assert.equal(mainUpdated.archived, true);
  assert.equal(mainUpdated.isDefault, true);
});

test("ThreadRepository.delete は main の削除を明示拒否する", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "adjutant-thread-repo-main-delete-"));
  t.after(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  const repository = createThreadRepository(stateDir);
  await repository.initialize();

  await assert.rejects(
    async () => {
      await repository.delete("main");
    },
    {
      message: "INVALID_REQUEST: main thread cannot be deleted",
    }
  );
});
