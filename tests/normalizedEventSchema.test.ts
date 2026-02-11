import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isNormalizedEvent } from "../src/core/validateEvent.js";
import type { NormalizedEvent } from "../src/core/events.js";

const baseEvent: NormalizedEvent = {
  schema: "reaclog.event.v1.1",
  uid: "slack:C123@1711111111.000200",
  source: "slack",
  kind: "post",
  actor: "tester",
  subject: "テスト",
  ts: "2024-03-22T21:38:31+09:00",
  logged_at: "2024-03-22T21:40:00+09:00",
  meta: { channel: "#dev" },
  detail: {
    slack: { channel_id: "C123", channel_name: "dev", text: "hello" },
  },
};

describe("NormalizedEvent schema validator", () => {
  it("有効なイベントをtrueと判定する", () => {
    assert.ok(isNormalizedEvent(baseEvent));
  });

  it("schemaやuidが欠如しているとfalse", () => {
    const invalid = { ...baseEvent, schema: "other" } as unknown;
    assert.equal(isNormalizedEvent(invalid), false);

    const invalidUid = { ...baseEvent, uid: "" } as unknown;
    assert.equal(isNormalizedEvent(invalidUid), false);
  });
});
