import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { DayPageData } from "$lib/viewModels/day";
import { resetConfigCache } from "../../../../lib/server/config";
import { load } from "../+page.server";

const TARGET_DATE = "2025-11-03";

describe("routes/day/[date]/+page.server", () => {
  let dataDir: string;
  const originalDataEnv = process.env.REACLOG_DATA_DIR;
  const originalConfigEnv = process.env.REACLOG_CONFIG_DIR;

  beforeEach(() => {
    resetConfigCache();
    dataDir = mkdtempSync(join(tmpdir(), "reaclog-day-"));
    process.env.REACLOG_DATA_DIR = dataDir;
    process.env.REACLOG_CONFIG_DIR = join(dataDir, "config");
    seedData();
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    resetConfigCache();
    if (originalDataEnv === undefined) {
      delete process.env.REACLOG_DATA_DIR;
    } else {
      process.env.REACLOG_DATA_DIR = originalDataEnv;
    }
    if (originalConfigEnv === undefined) {
      delete process.env.REACLOG_CONFIG_DIR;
    } else {
      process.env.REACLOG_CONFIG_DIR = originalConfigEnv;
    }
  });

  it("指定日のイベントとサマリを返す", async () => {
    const result = (await load({
      params: { date: TARGET_DATE },
      url: new URL(`http://example.test/day/${TARGET_DATE}`),
      locals: {},
      depends: vi.fn(),
      fetch: vi.fn(),
      setHeaders: vi.fn(),
    } as never)) as DayPageData;

    expect(result.date).toBe(TARGET_DATE);
    expect(result.summary).toContain("# レポート");
    expect(result.events.map((ev) => ev.uid)).toEqual(["gh:1", "slack:msg", "slack:reaction"]);
    expect(result.sources).toEqual([
      { name: "github", count: 1, selected: true },
      { name: "slack", count: 2, selected: true },
    ]);
    expect(result.clipboardTemplate.origin).toBe("default");
    expect(result.clipboardTemplate.source.length).toBeGreaterThan(0);
    expect(result.slackWorkspaceBaseUrl).toBeNull();
    expect(result.llm.models).toEqual(["gpt-4o", "gpt-4.1-mini"]);
    expect(result.llm.defaultModel).toBe("gpt-4o");
  });

  it("source クエリでフィルタする", async () => {
    const result = (await load({
      params: { date: TARGET_DATE },
      url: new URL(`http://example.test/day/${TARGET_DATE}?source=slack`),
      locals: {},
      depends: vi.fn(),
      fetch: vi.fn(),
      setHeaders: vi.fn(),
    } as never)) as DayPageData;

    expect(result.events.map((ev) => ev.source)).toEqual(["slack", "slack"]);
    expect(result.sources).toEqual([
      { name: "github", count: 1, selected: false },
      { name: "slack", count: 2, selected: true },
    ]);
    expect(result.slackWorkspaceBaseUrl).toBeNull();
    expect(result.llm.models).toContain("gpt-4o");
  });

  it("サマリが存在しない場合は null", async () => {
    const [year, month, day] = TARGET_DATE.split("-");
    const summaryPath = join(dataDir, year, month, day, "summaries", "daily.md");
    unlinkSync(summaryPath);

    const result = (await load({
      params: { date: TARGET_DATE },
      url: new URL(`http://example.test/day/${TARGET_DATE}`),
      locals: {},
      depends: vi.fn(),
      fetch: vi.fn(),
      setHeaders: vi.fn(),
    } as never)) as DayPageData;

    expect(result.summary).toBeNull();
  });

  it("Slack ワークスペースのベース URL を環境変数から読み込む", async () => {
    process.env.REACLOG_SLACK_WORKSPACE = "example-team";
    resetConfigCache();

    const result = (await load({
      params: { date: TARGET_DATE },
      url: new URL(`http://example.test/day/${TARGET_DATE}`),
      locals: {},
      depends: vi.fn(),
      fetch: vi.fn(),
      setHeaders: vi.fn(),
    } as never)) as DayPageData;

    expect(result.slackWorkspaceBaseUrl).toBe("https://example-team.slack.com");

    delete process.env.REACLOG_SLACK_WORKSPACE;
    resetConfigCache();
  });

  function seedData() {
    const [year, month, day] = TARGET_DATE.split("-");
    const dayDir = join(dataDir, year, month, day);

    mkdirSync(join(dataDir, "config"), { recursive: true });
    writeFileSync(
      join(dataDir, "config", "reaclog.config.json"),
      JSON.stringify({
        llm: {
          models: ["gpt-4o", "gpt-4.1-mini"],
          defaultModel: "gpt-4o",
        },
      }),
      "utf-8"
    );

    mkdirSync(join(dayDir, "slack"), { recursive: true });
    writeJsonl(join(dayDir, "slack", "events.jsonl"), [
      {
        uid: "slack:msg",
        source: "slack",
        kind: "post",
        ts: "2025-11-03T08:00:00+09:00",
        logged_at: "2025-11-03T08:00:01+09:00",
      },
      {
        uid: "slack:reaction",
        source: "slack",
        kind: "reaction",
        ts: "2025-11-03T08:30:00+09:00",
        logged_at: "2025-11-03T08:30:01+09:00",
      },
    ]);

    mkdirSync(join(dayDir, "github"), { recursive: true });
    writeJsonl(join(dayDir, "github", "events.jsonl"), [
      {
        uid: "gh:1",
        source: "github",
        kind: "issue",
        ts: "2025-11-03T07:00:00+09:00",
        logged_at: "2025-11-03T07:00:02+09:00",
      },
    ]);

    mkdirSync(join(dayDir, "summaries"), { recursive: true });
    writeFileSync(join(dayDir, "summaries", "daily.md"), "# レポート\n\n- テスト");
  }
});

function writeJsonl(filePath: string, events: Array<Record<string, unknown>>) {
  writeFileSync(filePath, `${events.map((ev) => JSON.stringify(ev)).join("\n")}\n`);
}
