import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryPathGuard } from "../../src/assistant/memory-search/path-guard.js";

describe("MemoryPathGuard", () => {
  it("MEMORY.md と memory/*.md のみ許可する", async () => {
    const workspaceDir = await mkdtemp(`${tmpdir()}/adjutant-memory-guard-`);
    try {
      await mkdir(join(workspaceDir, "memory"), { recursive: true });
      await writeFile(join(workspaceDir, "MEMORY.md"), "root memory", "utf8");
      await writeFile(join(workspaceDir, "memory", "2026-02-21.md"), "daily memory", "utf8");
      const guard = new MemoryPathGuard(workspaceDir);

      const a = await guard.resolveReadablePath("MEMORY.md");
      const b = await guard.resolveReadablePath("memory/2026-02-21.md");
      assert.equal(a.relPath, "MEMORY.md");
      assert.equal(b.relPath, "memory/2026-02-21.md");
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("workspace 外 path と symlink path は拒否する", async () => {
    const baseDir = await mkdtemp(`${tmpdir()}/adjutant-memory-guard-`);
    const workspaceDir = join(baseDir, "workspace");
    const outsideDir = join(baseDir, "outside");
    try {
      await mkdir(join(workspaceDir, "memory"), { recursive: true });
      await mkdir(outsideDir, { recursive: true });
      await writeFile(join(workspaceDir, "MEMORY.md"), "root memory", "utf8");
      await writeFile(join(outsideDir, "secret.md"), "top secret", "utf8");
      await symlink(join(outsideDir, "secret.md"), join(workspaceDir, "memory", "symlink.md"));

      const guard = new MemoryPathGuard(workspaceDir);
      await assert.rejects(guard.resolveReadablePath("../../outside/secret.md"), /path required/);
      await assert.rejects(guard.resolveReadablePath("memory/symlink.md"), /path required/);
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });
});
