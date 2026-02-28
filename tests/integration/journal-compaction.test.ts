import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { JournalCompactor } from "../../src/runtime/journal-compactor.js";
import { JournalStore } from "../../src/runtime/journal-store.js";

test("JournalCompactor compacts processed records and keeps tail readable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "journal-compaction-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const filePath = join(root, "inbox.jsonl");
  const store = new JournalStore<{ id: string }>(filePath);

  await store.append({ id: "a" });
  await store.append({ id: "b" });
  await store.append({ id: "c" });
  await store.append({ id: "d" });

  const compactor = new JournalCompactor(filePath);
  const result = await compactor.compact({ segment: 0, offset: 1 });

  assert.equal(result.compacted, true);
  assert.equal(result.removedLines, 2);
  assert.equal(result.remainingLines, 2);
  assert.deepEqual(result.nextCursor, { segment: 0, offset: 0 });

  const remaining = await store.drain(result.nextCursor);
  assert.deepEqual(
    remaining.map((entry) => entry.value.id),
    ["c", "d"]
  );
});

test("JournalCompactor does not compact when cursor segment is not owned", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "journal-compaction-segment-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const filePath = join(root, "inbox.jsonl");
  const store = new JournalStore<{ id: string }>(filePath);

  await store.append({ id: "a" });
  await store.append({ id: "b" });

  const compactor = new JournalCompactor(filePath);
  const result = await compactor.compact({ segment: 1, offset: 0 });

  assert.equal(result.compacted, false);

  const records = await store.drain({ segment: 0, offset: 0 });
  assert.deepEqual(
    records.map((entry) => entry.value.id),
    ["a", "b"]
  );
});
