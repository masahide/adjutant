import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";

import type { DashboardLoadData } from "$lib/viewModels/dashboard";
import type { DayPageData } from "$lib/viewModels/day";
import type { RawPageData } from "$lib/viewModels/raw";
import { resetConfigCache } from "../src/lib/server/config";
import { load as dashboardLoad } from "../src/routes/+page.server";
import { load as dayLoad } from "../src/routes/day/[date]/+page.server";
import { load as rawLoad } from "../src/routes/day/[date]/raw/+page.server";
import type { JsonlFixture } from "./utils";
import { createJsonlFixture, writeDailySummary } from "./utils";

describe("End-to-end data flow", () => {
  let dataDir: string;
  let fixture: JsonlFixture;
  const originalDataDir = process.env.REACLOG_DATA_DIR;
  const originalConfigDir = process.env.REACLOG_CONFIG_DIR;

  beforeEach(async () => {
    fixture = await createJsonlFixture({ source: "slack", date: "2025-11-03" });
    dataDir = fixture.dataDir;
    process.env.REACLOG_DATA_DIR = dataDir;
    process.env.REACLOG_CONFIG_DIR = join(dataDir, "config");
    resetConfigCache();
    await seedDataset();
  });

  afterEach(async () => {
    await fixture.cleanup();
    resetConfigCache();
    if (originalDataDir) {
      process.env.REACLOG_DATA_DIR = originalDataDir;
    } else {
      delete process.env.REACLOG_DATA_DIR;
    }

    if (originalConfigDir) {
      process.env.REACLOG_CONFIG_DIR = originalConfigDir;
    } else {
      delete process.env.REACLOG_CONFIG_DIR;
    }
  });

  it("ダッシュボードから日次詳細、生データまで一連のロードが成功する", async () => {
    const dashboard = (await dashboardLoad({
      depends: vi.fn(),
      locals: {},
      params: {},
      url: new URL("http://example.test/"),
      fetch: vi.fn(),
      setHeaders: vi.fn(),
    } as never)) as DashboardLoadData;

    expect(dashboard.days[0]).toMatchObject({ date: "2025-11-03", total: 2 });

    const day = (await dayLoad({
      depends: vi.fn(),
      locals: {},
      params: { date: "2025-11-03" },
      url: new URL("http://example.test/day/2025-11-03"),
      fetch: vi.fn(),
      setHeaders: vi.fn(),
    } as never)) as DayPageData;

    expect(day.events).toHaveLength(2);
    expect(day.summary).toContain("## Done");

    const raw = (await rawLoad({
      depends: vi.fn(),
      locals: {},
      params: { date: "2025-11-03" },
      url: new URL("http://example.test/day/2025-11-03/raw"),
      fetch: vi.fn(),
      setHeaders: vi.fn(),
    } as never)) as RawPageData;

    const slackRaw = raw.files.find((file) => file.source === "slack");
    expect(slackRaw?.lines).toContainEqual(
      JSON.stringify({ uid: "1", source: "slack", kind: "post" })
    );
  });

  async function seedDataset() {
    await fixture.append({ uid: "1", source: "slack", kind: "post" });
    await fixture.append({ uid: "2", source: "slack", kind: "reaction" });
    await writeDailySummary({
      dataDir,
      date: fixture.date,
      content: "# 2025-11-03\n\n## Done\n- sample",
    });
  }
});
