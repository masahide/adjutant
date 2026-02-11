import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { readDailyEvents, readDailySummary } from "../data";

const SAMPLE_DATE = "2025-11-03";

function writeJsonl(dir: string, lines: Array<Record<string, unknown>>) {
  writeFileSync(dir, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
}

describe("data loader", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "reaclog-browser-"));
    const dateDir = join(dataDir, "2025", "11", "03");
    mkdirSync(join(dateDir, "slack"), { recursive: true });
    mkdirSync(join(dateDir, "github"), { recursive: true });
    mkdirSync(join(dateDir, "summaries"), { recursive: true });

    writeJsonl(join(dateDir, "slack", "events.jsonl"), [
      {
        schema: "reaclog.event.v1.1",
        uid: "slack:1",
        source: "slack",
        kind: "post",
        ts: "2025-11-03T08:00:00+09:00",
        logged_at: "2025-11-03T08:00:01+09:00",
        detail: { slack: { text: "最初の投稿" } },
      },
      {
        schema: "reaclog.event.v1.1",
        uid: "slack:2",
        source: "slack",
        kind: "reaction",
        ts: "2025-11-03T09:00:00+09:00",
        logged_at: "2025-11-03T09:00:01+09:00",
        detail: { slack: { emoji: "eyes" } },
      },
    ]);

    writeJsonl(join(dateDir, "github", "events.jsonl"), [
      {
        schema: "reaclog.event.v1.1",
        uid: "gh:1",
        source: "github",
        kind: "issue",
        ts: "2025-11-03T07:30:00+09:00",
        logged_at: "2025-11-03T07:30:05+09:00",
        detail: { github: { title: "Fix bug" } },
      },
    ]);

    writeFileSync(join(dateDir, "summaries", "daily.md"), "# Summary\n\n- エントリ1");
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("指定日の JSONL を読み取りソート済みのイベントを返す", async () => {
    const result = await readDailyEvents({ dataDir, date: SAMPLE_DATE });
    expect(result.events.map((event) => event.uid)).toEqual(["gh:1", "slack:1", "slack:2"]);
    expect(result.bySource).toEqual({ github: 1, slack: 2 });
  });

  it("日次サマリを返す", async () => {
    const summary = await readDailySummary({ dataDir, date: SAMPLE_DATE });
    expect(summary).toContain("Summary");
  });
});
