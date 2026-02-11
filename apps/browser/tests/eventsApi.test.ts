import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetConfigCache } from "../src/lib/server/config";
import type { JsonlFixture } from "./utils";
import { createJsonlFixture } from "./utils";
import { GET as eventsHandler } from "../src/routes/day/[date]/events/+server";

describe("/day/[date]/events", () => {
  let fixture: JsonlFixture;
  const originalDataDir = process.env.REACLOG_DATA_DIR;

  beforeEach(async () => {
    fixture = await createJsonlFixture({ source: "slack", date: "2025-11-03" });
    process.env.REACLOG_DATA_DIR = fixture.dataDir;
    resetConfigCache();
  });

  afterEach(async () => {
    await fixture.cleanup();
    resetConfigCache();
    if (originalDataDir === undefined) {
      delete process.env.REACLOG_DATA_DIR;
    } else {
      process.env.REACLOG_DATA_DIR = originalDataDir;
    }
  });

  it("JSON 形式でタイムラインイベントを返す", async () => {
    await fixture.append({ uid: "1", source: "slack", kind: "post" });
    await fixture.append({ uid: "2", source: "slack", kind: "reaction" });

    const response = await eventsHandler({
      request: new Request("http://example.test/day/2025-11-03/events"),
      params: { date: "2025-11-03" },
      locals: {},
      platform: {},
      fetch,
      cookies: undefined,
      url: new URL("http://example.test/day/2025-11-03/events"),
    } as never);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-cache");
    const body = (await response.json()) as { events: Array<Record<string, unknown>> };
    expect(body.events).toHaveLength(2);
    expect(body.events[0]).toMatchObject({ source: "slack" });
  });
});
