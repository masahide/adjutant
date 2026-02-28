import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { JournalStore } from "../../src/runtime/journal-store.js";

test("JournalStore append/drain keeps append-only order", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "journal-store-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const filePath = join(root, "inbox.jsonl");
  const store = new JournalStore<{ id: string }>(filePath);

  const firstCursor = await store.append({ id: "a" });
  const secondCursor = await store.append({ id: "b" });

  assert.deepEqual(firstCursor, { segment: 0, offset: 0 });
  assert.deepEqual(secondCursor, { segment: 0, offset: 1 });

  const records = await store.drain({ segment: 0, offset: 0 });
  assert.equal(records.length, 2);
  assert.deepEqual(records[0]?.value, { id: "a" });
  assert.deepEqual(records[1]?.value, { id: "b" });
});

test("JournalStore drain honors cursor and skips invalid json line", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "journal-store-invalid-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const filePath = join(root, "inbox.jsonl");
  await writeFile(filePath, '{"id":"a"}\nnot-json\n{"id":"c"}\n', "utf8");

  const store = new JournalStore<{ id: string }>(filePath);
  const records = await store.drain({ segment: 0, offset: 1 });

  assert.equal(records.length, 1);
  assert.deepEqual(records[0]?.value, { id: "c" });
  assert.deepEqual(records[0]?.cursor, { segment: 0, offset: 2 });
});
