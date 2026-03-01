import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MemoryPathGuard } from "../../../src/assistant/memory/path-guard.js";

test("MemoryPathGuard allows MEMORY.md and memory/*.md only", async (t) => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "adjutant-memory-guard-"));
  t.after(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  await mkdir(join(workspaceDir, "memory"), { recursive: true });
  await writeFile(join(workspaceDir, "MEMORY.md"), "long term\n", "utf8");
  await writeFile(join(workspaceDir, "memory", "daily.md"), "daily\n", "utf8");
  await writeFile(join(workspaceDir, "notes.txt"), "nope\n", "utf8");

  const guard = new MemoryPathGuard(workspaceDir);

  const longTerm = await guard.resolveReadablePath("MEMORY.md");
  assert.equal(longTerm.relPath, "MEMORY.md");

  const daily = await guard.resolveReadablePath("memory/daily.md");
  assert.equal(daily.relPath, "memory/daily.md");

  await assert.rejects(async () => await guard.resolveReadablePath("../etc/passwd"));
  await assert.rejects(async () => await guard.resolveReadablePath("notes.txt"));
});

test("MemoryPathGuard rejects symlink targets", async (t) => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "adjutant-memory-symlink-"));
  t.after(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  await mkdir(join(workspaceDir, "memory"), { recursive: true });
  const outsidePath = join(workspaceDir, "..", "outside.md");
  await writeFile(outsidePath, "outside\n", "utf8");
  await symlink(outsidePath, join(workspaceDir, "memory", "link.md"));

  const guard = new MemoryPathGuard(workspaceDir);
  await assert.rejects(async () => await guard.resolveReadablePath("memory/link.md"));
});
