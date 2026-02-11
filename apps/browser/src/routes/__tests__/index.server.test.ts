import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { DashboardLoadData } from "$lib/viewModels/dashboard";
import { resetConfigCache } from "../../lib/server/config";
import { load } from "../+page.server";

function writeJsonl(filePath: string, events: Array<Record<string, unknown>>) {
  writeFileSync(filePath, `${events.map((ev) => JSON.stringify(ev)).join("\n")}\n`);
}

describe("routes/+page.server load", () => {
  let dataDir: string;
  const cleanupEnv: string | undefined = process.env.REACLOG_DATA_DIR;

  beforeEach(() => {
    resetConfigCache();
    dataDir = mkdtempSync(join(tmpdir(), "reaclog-dashboard-"));
    process.env.REACLOG_DATA_DIR = dataDir;

    createDay("2025-11-03", {
      slack: [
        {
          uid: "slack:post",
          source: "slack",
          ts: "2025-11-03T08:00:00+09:00",
          logged_at: "2025-11-03T08:00:01+09:00",
          detail: { slack: { text: "投稿" } },
        },
        {
          uid: "slack:reaction",
          source: "slack",
          ts: "2025-11-03T09:00:00+09:00",
          logged_at: "2025-11-03T09:00:01+09:00",
          detail: { slack: { emoji: "eyes" } },
        },
      ],
      github: [
        {
          uid: "gh:1",
          source: "github",
          ts: "2025-11-03T07:30:00+09:00",
          logged_at: "2025-11-03T07:30:05+09:00",
          detail: { github: { title: "Issue" } },
        },
      ],
      summary: "# 11/03\n\n- Slack 投稿\n",
    });

    createDay("2025-11-02", {
      slack: [
        {
          uid: "slack:older",
          source: "slack",
          ts: "2025-11-02T10:00:00+09:00",
          logged_at: "2025-11-02T10:00:01+09:00",
          detail: { slack: { text: "前日" } },
        },
      ],
    });

    createDay("2025-11-01", {
      github: [
        {
          uid: "gh:older",
          source: "github",
          ts: "2025-11-01T12:00:00+09:00",
          logged_at: "2025-11-01T12:00:05+09:00",
          detail: { github: { title: "古い" } },
        },
      ],
    });
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    resetConfigCache();
    if (cleanupEnv === undefined) {
      delete process.env.REACLOG_DATA_DIR;
    } else {
      process.env.REACLOG_DATA_DIR = cleanupEnv;
    }
  });

  it("最新日から順にサマリカード用データを返す", async () => {
    const result = (await load({
      depends: vi.fn(),
      locals: {},
      params: {},
      url: new URL("http://example.test/"),
      fetch: vi.fn(),
      setHeaders: vi.fn(),
    } as never)) as DashboardLoadData;

    expect(result.days.map((day) => day.date)).toEqual(["2025-11-03", "2025-11-02", "2025-11-01"]);
    expect(result.days[0]).toMatchObject({
      date: "2025-11-03",
      total: 3,
      hasSummary: true,
    });
    expect(result.days[0].sources).toEqual(
      expect.arrayContaining([
        { source: "slack", count: 2 },
        { source: "github", count: 1 },
      ])
    );
    expect(result.days[0].summaryPreview).toContain("# 11/03");
    expect(result.generatedAt).toMatch(/T/);
  });

  function createDay(
    date: string,
    data: {
      slack?: Array<Record<string, unknown>>;
      github?: Array<Record<string, unknown>>;
      summary?: string;
    }
  ) {
    const [year, month, day] = date.split("-");
    const dayDir = join(dataDir, year, month, day);
    if (data.slack) {
      mkdirSync(join(dayDir, "slack"), { recursive: true });
      writeJsonl(join(dayDir, "slack", "events.jsonl"), data.slack);
    }
    if (data.github) {
      mkdirSync(join(dayDir, "github"), { recursive: true });
      writeJsonl(join(dayDir, "github", "events.jsonl"), data.github);
    }
    if (data.summary) {
      mkdirSync(join(dayDir, "summaries"), { recursive: true });
      writeFileSync(join(dayDir, "summaries", "daily.md"), data.summary);
    }
  }
});
