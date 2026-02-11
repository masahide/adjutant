import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetConfigCache } from "../src/lib/server/config";
import type { JsonlFixture } from "./utils";
import { createJsonlFixture, waitForExpect } from "./utils";
import { GET as streamHandler } from "../src/routes/day/[date]/stream/+server";

describe("/day/[date]/stream", () => {
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

  it("JSONL への追記を SSE で通知する", async () => {
    const response = await streamHandler({
      request: new Request("http://example.test/day/2025-11-03/stream"),
      params: { date: "2025-11-03" },
      locals: {},
      platform: {},
      fetch,
      cookies: undefined,
      url: new URL("http://example.test/day/2025-11-03/stream"),
    } as never);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const reader = response.body?.getReader();
    expect(reader).toBeDefined();

    const decoder = new TextDecoder();
    let buffer = "";
    let cancelled = false;

    const pump = (async () => {
      if (!reader) {
        return;
      }
      while (!cancelled) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        if (value) {
          buffer += decoder.decode(value, { stream: true });
        }
      }
    })();

    await waitForExpect(() => {
      expect(buffer).toContain("event: ready");
    }, 1000);

    await fixture.append({ uid: "1", source: "slack", kind: "post" });
    await fixture.append({ uid: "2", source: "slack", kind: "reaction" });

    await waitForExpect(() => {
      expect(buffer).toContain('"uid":"1"');
      expect(buffer).toContain('"uid":"2"');
    }, 2000);

    cancelled = true;
    await reader?.cancel();
    await pump;
  });
});
