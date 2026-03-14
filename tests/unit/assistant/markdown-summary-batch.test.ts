import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createMarkdownSummaryBatchService } from "../../../src/assistant/markdown-summary-batch.js";

test("markdown summary batch processes transcript incrementally with watermark dedupe", async (t) => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "adjutant-summary-batch-"));
  t.after(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  const transcriptsDir = join(workspaceDir, "transcripts");
  const sessionDir = join(transcriptsDir, "main");
  await mkdir(sessionDir, { recursive: true });
  const transcriptPath = join(sessionDir, "2026-02-28.jsonl");
  await writeFile(
    transcriptPath,
    [
      JSON.stringify({
        role: "user",
        text: "please remember project setup",
        timestamp: "2026-02-28T10:00:00.000Z",
      }),
      JSON.stringify({
        role: "assistant",
        text: "noted and summarized",
        timestamp: "2026-02-28T10:00:05.000Z",
      }),
    ].join("\n"),
    "utf8"
  );

  const watermarkPath = join(workspaceDir, ".adjutant", "state", "agents", "main", "summary.json");
  const service = createMarkdownSummaryBatchService({
    workspaceDir,
    timezone: "UTC",
    sessionTranscriptsDir: transcriptsDir,
    watermarkPath,
    messages: 15,
    maxSessions: 10,
  });

  const first = await service.runOnce();
  assert.equal(first.processedSessions, 1);
  assert.equal(first.writtenEntries > 0, true);

  const dailyPath = join(workspaceDir, "memory", "2026-02-28.md");
  const dailyBefore = await readFile(dailyPath, "utf8");
  assert.equal(dailyBefore.includes("Session Summary"), true);
  assert.equal(dailyBefore.includes("Session Key: main"), true);

  const second = await service.runOnce();
  assert.equal(second.processedSessions, 1);
  assert.equal(second.writtenEntries, 0);

  const dailyAfter = await readFile(dailyPath, "utf8");
  assert.equal(dailyAfter, dailyBefore);
});
