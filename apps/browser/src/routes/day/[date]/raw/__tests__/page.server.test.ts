import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { RawPageData } from "$lib/viewModels/raw";
import { resetConfigCache } from "../../../../../lib/server/config";
import { load } from "../+page.server";

const TARGET_DATE = "2025-11-03";

describe("routes/day/[date]/raw/+page.server", () => {
  let dataDir: string;
  const originalEnv = process.env.REACLOG_DATA_DIR;

  beforeEach(() => {
    resetConfigCache();
    dataDir = mkdtempSync(join(tmpdir(), "reaclog-raw-"));
    process.env.REACLOG_DATA_DIR = dataDir;
    seedData();
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    resetConfigCache();
    if (originalEnv === undefined) {
      delete process.env.REACLOG_DATA_DIR;
    } else {
      process.env.REACLOG_DATA_DIR = originalEnv;
    }
  });

  it("JSONL の生データを返す", async () => {
    const result = (await load({
      params: { date: TARGET_DATE },
      url: new URL(`http://example.test/day/${TARGET_DATE}/raw`),
      locals: {},
      depends: vi.fn(),
      fetch: vi.fn(),
      setHeaders: vi.fn(),
    } as never)) as RawPageData;

    expect(result.date).toBe(TARGET_DATE);
    expect(result.sources).toEqual(["github", "slack"]);
    expect(result.files.find((file) => file.source === "slack")?.lines).toHaveLength(2);
  });

  it("データが存在しない場合は 404", async () => {
    await expect(
      load({
        params: { date: "2025-11-01" },
        url: new URL("http://example.test/day/2025-11-01/raw"),
        locals: {},
        depends: vi.fn(),
        fetch: vi.fn(),
        setHeaders: vi.fn(),
      } as never)
    ).rejects.toMatchObject({ status: 404 });
  });

  function seedData() {
    const [year, month, day] = TARGET_DATE.split("-");
    const dayDir = join(dataDir, year, month, day);

    mkdirSync(join(dayDir, "slack"), { recursive: true });
    writeFileSync(
      join(dayDir, "slack", "events.jsonl"),
      `{"uid":"1","source":"slack"}\n{"uid":"2","source":"slack"}\n`
    );

    mkdirSync(join(dayDir, "github"), { recursive: true });
    writeFileSync(join(dayDir, "github", "events.jsonl"), `{"uid":"3","source":"github"}\n`);
  }
});
