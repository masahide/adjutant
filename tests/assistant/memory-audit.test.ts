import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configureAgentAuditLogger,
  flushAgentAuditLoggerForTest,
  resetAgentAuditLoggerForTest,
} from "../../src/assistant/agent-audit.js";
import { readMemoryFiles } from "../../src/assistant/memory-reader.js";
import { appendDailyMemory, updateLongTermMemory } from "../../src/assistant/memory-writer.js";

describe("memory audit", () => {
  afterEach(() => {
    resetAgentAuditLoggerForTest();
  });

  it("memory reader/writer が file.read/file.write を記録する", async () => {
    const workspaceDir = await mkdtemp(`${tmpdir()}/adjutant-memory-audit-`);
    try {
      const auditPath = join(workspaceDir, "audit", "agent-audit.ndjson");
      configureAgentAuditLogger({
        enabled: true,
        path: auditPath,
        maxFieldChars: 4000,
      });

      await mkdir(join(workspaceDir, "memory"), { recursive: true });
      await writeFile(join(workspaceDir, "MEMORY.md"), "long-term memory", "utf8");
      await writeFile(join(workspaceDir, "memory", "2026-02-23.md"), "daily memory", "utf8");

      const scope = { runId: "run-io-1", sessionKey: "main" };
      await readMemoryFiles({
        workspaceDir,
        timezone: "UTC",
        now: new Date("2026-02-23T12:00:00.000Z"),
        auditScope: scope,
      });
      await appendDailyMemory("new note", {
        workspaceDir,
        timezone: "UTC",
        now: new Date("2026-02-23T12:00:00.000Z"),
        auditScope: scope,
      });
      await updateLongTermMemory("replaced memory", {
        workspaceDir,
        timezone: "UTC",
        auditScope: scope,
      });

      await flushAgentAuditLoggerForTest();

      const events = (await readFile(auditPath, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { type: string; path?: string; status?: string });

      const readEvents = events.filter((event) => event.type === "file.read");
      const writeEvents = events.filter((event) => event.type === "file.write");

      assert.equal(readEvents.length >= 3, true);
      assert.equal(writeEvents.length >= 2, true);
      assert.equal(
        readEvents.some((event) => event.path === "MEMORY.md" && event.status === "ok"),
        true
      );
      assert.equal(
        readEvents.some((event) => event.status === "error"),
        false
      );
      assert.equal(
        writeEvents.some((event) => event.path === "memory/2026-02-23.md" && event.status === "ok"),
        true
      );
      assert.equal(
        writeEvents.some((event) => event.path === "MEMORY.md" && event.status === "ok"),
        true
      );
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("memory reader は ENOENT を status:ok bytes:0 で記録する", async () => {
    const workspaceDir = await mkdtemp(`${tmpdir()}/adjutant-memory-audit-`);
    try {
      const auditPath = join(workspaceDir, "audit", "agent-audit.ndjson");
      configureAgentAuditLogger({
        enabled: true,
        path: auditPath,
        maxFieldChars: 4000,
      });

      await readMemoryFiles({
        workspaceDir,
        timezone: "UTC",
        now: new Date("2026-02-23T12:00:00.000Z"),
        auditScope: { runId: "run-io-missing", sessionKey: "main" },
      });
      await flushAgentAuditLoggerForTest();

      const events = (await readFile(auditPath, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as {
              type: string;
              runId?: string;
              path?: string;
              status?: string;
              bytes?: number;
              error?: string;
            }
        )
        .filter((event) => event.type === "file.read" && event.runId === "run-io-missing");

      assert.equal(events.length, 3);
      assert.equal(
        events.some(
          (event) => event.path === "MEMORY.md" && event.status === "ok" && event.bytes === 0
        ),
        true
      );
      assert.equal(
        events.every((event) => event.status === "ok"),
        true
      );
      assert.equal(
        events.every((event) => event.bytes === 0),
        true
      );
      assert.equal(
        events.some((event) => event.error !== undefined),
        false
      );
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
