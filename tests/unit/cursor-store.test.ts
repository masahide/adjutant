import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CursorStore } from "../../src/runtime/cursor-store.js";

test("CursorStore.load returns default cursor when file does not exist", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cursor-store-default-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const store = new CursorStore(join(root, "cursor.json"));
  const cursor = await store.load();

  assert.deepEqual(cursor, { segment: 0, offset: 0 });
});

test("CursorStore.commit writes atomically via temp file rename", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cursor-store-commit-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const filePath = join(root, "cursor.json");
  const store = new CursorStore(filePath);

  await store.commit({ segment: 0, offset: 3 });
  await store.commit({ segment: 0, offset: 4 });

  const cursor = await store.load();
  assert.deepEqual(cursor, { segment: 0, offset: 4 });

  const files = await readdir(root);
  assert.deepEqual(files.sort(), ["cursor.json"]);
});
