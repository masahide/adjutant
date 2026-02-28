import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMemoryFiles } from "../../src/assistant/memory-reader.js";
import { appendDailyMemory, updateLongTermMemory } from "../../src/assistant/memory-writer.js";

describe("MemoryReader / MemoryWriter", () => {
  it("timezone に応じて today/yesterday を解決して読み込める", async () => {
    const tempDir = await mkdtemp(`${tmpdir()}/adjutant-memory-`);
    try {
      const now = new Date("2026-02-15T00:30:00.000Z");
      await appendDailyMemory("today-utc", {
        workspaceDir: tempDir,
        timezone: "UTC",
        now,
      });
      await appendDailyMemory("today-pst", {
        workspaceDir: tempDir,
        timezone: "America/Los_Angeles",
        now,
      });

      const dailyFiles = (await readdir(join(tempDir, "memory"))).sort();
      assert.deepEqual(dailyFiles, ["2026-02-14.md", "2026-02-15.md"]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("MemoryReader はファイル不在時に null を返す", async () => {
    const tempDir = await mkdtemp(`${tmpdir()}/adjutant-memory-`);
    try {
      const result = await readMemoryFiles({
        workspaceDir: tempDir,
        timezone: "UTC",
        now: new Date("2026-02-15T12:00:00.000Z"),
      });
      assert.deepEqual(result, {
        longTerm: null,
        daily: null,
        yesterday: null,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("MemoryReader は MEMORY.md / daily / yesterday を読み込める", async () => {
    const tempDir = await mkdtemp(`${tmpdir()}/adjutant-memory-`);
    try {
      const now = new Date("2026-02-15T12:00:00.000Z");
      await writeFile(join(tempDir, "MEMORY.md"), "long-term", "utf8");
      await mkdir(join(tempDir, "memory"), { recursive: true });
      await writeFile(join(tempDir, "memory", "2026-02-15.md"), "daily", "utf8");
      await writeFile(join(tempDir, "memory", "2026-02-14.md"), "yesterday", "utf8");

      const result = await readMemoryFiles({
        workspaceDir: tempDir,
        timezone: "UTC",
        now,
      });
      assert.equal(result.longTerm, "long-term");
      assert.equal(result.daily, "daily");
      assert.equal(result.yesterday, "yesterday");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("appendDailyMemory は daily ファイルに追記する", async () => {
    const tempDir = await mkdtemp(`${tmpdir()}/adjutant-memory-`);
    try {
      const now = new Date("2026-02-15T12:00:00.000Z");
      await appendDailyMemory("first", { workspaceDir: tempDir, timezone: "UTC", now });
      await appendDailyMemory("second", { workspaceDir: tempDir, timezone: "UTC", now });

      const content = await readFile(join(tempDir, "memory", "2026-02-15.md"), "utf8");
      assert.ok(content.includes("first"));
      assert.ok(content.includes("second"));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("updateLongTermMemory は MEMORY.md を上書きする", async () => {
    const tempDir = await mkdtemp(`${tmpdir()}/adjutant-memory-`);
    try {
      await updateLongTermMemory("v1", { workspaceDir: tempDir, timezone: "UTC" });
      await updateLongTermMemory("v2", { workspaceDir: tempDir, timezone: "UTC" });

      const content = await readFile(join(tempDir, "MEMORY.md"), "utf8");
      assert.equal(content, "v2");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
