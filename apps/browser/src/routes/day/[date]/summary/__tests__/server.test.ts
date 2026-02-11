import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { resetConfigCache } from "../../../../../lib/server/config";
import { GET, POST, PUT } from "../+server";

const TARGET_DATE = "2025-11-03";

describe("routes/day/[date]/summary", () => {
  let dataDir: string;
  const originalDataEnv = process.env.REACLOG_DATA_DIR;
  const originalConfigEnv = process.env.REACLOG_CONFIG_DIR;

  beforeEach(() => {
    resetConfigCache();
    dataDir = mkdtempSync(join(tmpdir(), "reaclog-summary-api-"));
    process.env.REACLOG_DATA_DIR = dataDir;
    process.env.REACLOG_CONFIG_DIR = join(dataDir, "config");
    seedSummary();
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

  it("既存のサマリを読み込んで JSON を返す", async () => {
    const response = await GET({
      params: { date: TARGET_DATE },
      locals: {},
      fetch,
      request: new Request(`http://example.test/day/${TARGET_DATE}/summary`, {
        method: "GET",
      }),
      setHeaders: vi.fn(),
      url: new URL(`http://example.test/day/${TARGET_DATE}/summary`),
    } as never);

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.content).toMatch("# 既存サマリ");
    expect(body.exists).toBe(true);
    expect(typeof body.updatedAt === "string").toBe(true);
  });

  it("PUT で保存した内容を返す", async () => {
    const request = new Request(`http://example.test/day/${TARGET_DATE}/summary`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content: "# 更新後\n\n- 追記" }),
    });

    const saveResponse = await PUT({
      params: { date: TARGET_DATE },
      locals: {},
      fetch,
      request,
      setHeaders: vi.fn(),
      url: new URL(request.url),
    } as never);

    expect(saveResponse.status).toBe(200);
    const payload = (await saveResponse.json()) as { savedAt: string };
    expect(typeof payload.savedAt === "string").toBe(true);

    const getResponse = await GET({
      params: { date: TARGET_DATE },
      locals: {},
      fetch,
      request: new Request(`http://example.test/day/${TARGET_DATE}/summary`, {
        method: "GET",
      }),
      setHeaders: vi.fn(),
      url: new URL(`http://example.test/day/${TARGET_DATE}/summary`),
    } as never);

    const summary = (await getResponse.json()) as Record<string, unknown>;
    expect(summary.content).toBe("# 更新後\n\n- 追記");
    expect(summary.exists).toBe(true);
    expect(summary.updatedAt).toBe(payload.savedAt);
    expect(summary.assistantMessage ?? null).toBeNull();
    expect(summary.reasoning ?? null).toBeNull();
  });

  it("POST でサマリを初期化すると存在フラグ付きで返す", async () => {
    const request = new Request(`http://example.test/day/${TARGET_DATE}/summary`, {
      method: "POST",
      headers: {
        Accept: "application/json",
      },
    });

    const response = await POST({
      params: { date: TARGET_DATE },
      locals: {},
      fetch,
      request,
      setHeaders: vi.fn(),
      url: new URL(request.url),
    } as never);

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.exists).toBe(true);
    expect(typeof body.updatedAt === "string").toBe(true);
    expect(body.assistantMessage ?? null).toBeNull();
    expect(body.reasoning ?? null).toBeNull();
  });

  it("サマリが存在しない場合でも空稿を返す", async () => {
    const [year, month, day] = TARGET_DATE.split("-");
    const summaryPath = join(dataDir, year, month, day, "summaries", "daily.md");
    rmSync(summaryPath, { force: true });

    const response = await GET({
      params: { date: TARGET_DATE },
      locals: {},
      fetch,
      request: new Request(`http://example.test/day/${TARGET_DATE}/summary`, {
        method: "GET",
      }),
      setHeaders: vi.fn(),
      url: new URL(`http://example.test/day/${TARGET_DATE}/summary`),
    } as never);

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.exists).toBe(false);
    expect(body.content).toBe("");
    expect(body.updatedAt).toBeNull();
    expect(body.assistantMessage ?? null).toBeNull();
    expect(body.reasoning ?? null).toBeNull();
  });

  it("サマリが存在しない場合は初期コンテンツを生成する", async () => {
    const [year, month, day] = TARGET_DATE.split("-");
    const summaryPath = join(dataDir, year, month, day, "summaries", "daily.md");
    rmSync(summaryPath, { force: true });

    const request = new Request(`http://example.test/day/${TARGET_DATE}/summary`, {
      method: "POST",
      headers: {
        Accept: "application/json",
      },
    });

    const response = await POST({
      params: { date: TARGET_DATE },
      locals: {},
      fetch,
      request,
      setHeaders: vi.fn(),
      url: new URL(request.url),
    } as never);

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.exists).toBe(true);
    expect(typeof body.updatedAt === "string").toBe(true);
    expect(typeof body.content === "string").toBe(true);
    expect((body.content as string).length).toBeGreaterThan(0);
    expect(body.content).toContain("# ReacLog 日報");
    expect(body.content).toContain("## TODO / ブロッカー");
  });

  it("存在しない日付へのアクセスは 400", async () => {
    const response = await GET({
      params: { date: "" },
      locals: {},
      fetch,
      request: new Request("http://example.test/day//summary", { method: "GET" }),
      setHeaders: vi.fn(),
      url: new URL("http://example.test/day//summary"),
    } as never);

    expect(response.status).toBe(400);
  });

  function seedSummary() {
    const [year, month, day] = TARGET_DATE.split("-");
    const summaryDir = join(dataDir, year, month, day, "summaries");
    mkdirSync(summaryDir, { recursive: true });
    writeFileSync(join(summaryDir, "daily.md"), "# 既存サマリ\n\n- 初期化済み\n", "utf-8");
  }
});
