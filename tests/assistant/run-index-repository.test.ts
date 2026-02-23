import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  appendRunIndex,
  resolveSessionKeyByRunId,
} from "../../src/assistant/run-index-repository.js";

describe("run-index-repository", () => {
  it("runId -> sessionKey を追記し最新エントリを解決できる", async () => {
    const dir = await mkdtemp(`${tmpdir()}/adjutant-run-index-`);
    const path = join(dir, "run-index.ndjson");
    try {
      await appendRunIndex("run-1", "main", "2026-02-23T10:00:00.000Z", { path });
      await appendRunIndex("run-2", "thread:C1", "2026-02-23T10:00:01.000Z", { path });
      await appendRunIndex("run-1", "main-updated", "2026-02-23T10:00:02.000Z", { path });

      const run1 = await resolveSessionKeyByRunId("run-1", { path });
      const run2 = await resolveSessionKeyByRunId("run-2", { path });
      const unknown = await resolveSessionKeyByRunId("run-x", { path });

      assert.equal(run1, "main-updated");
      assert.equal(run2, "thread:C1");
      assert.equal(unknown, null);

      const lines = (await readFile(path, "utf8")).trim().split("\n").filter(Boolean);
      assert.equal(lines.length, 3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
