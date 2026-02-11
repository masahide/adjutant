import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { JsonlFixture } from "./utils";
import { createJsonlFixture, waitForExpect } from "./utils";

describe("JSONL フィクスチャのリアルタイム監視", () => {
  let fixture: JsonlFixture;

  beforeEach(async () => {
    fixture = await createJsonlFixture({ source: "slack" });
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  it("追記したイベントがウォッチャーに通知される", async () => {
    const received: Array<Record<string, unknown>> = [];
    const stop = fixture.watch((event) => {
      received.push(event);
    });

    await fixture.append({ uid: "1", source: "slack", kind: "post" });
    await fixture.append({ uid: "2", source: "slack", kind: "reaction" });

    await waitForExpect(() => {
      expect(received).toHaveLength(2);
      expect(received[0]).toMatchObject({ uid: "1" });
      expect(received[1]).toMatchObject({ uid: "2" });
    });

    stop();
  });
});
