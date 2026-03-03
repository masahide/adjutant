import assert from "node:assert/strict";
import test from "node:test";

import { isNormalizedEvent, isSlackNormalizedEvent } from "../../../src/core/events.js";

test("isNormalizedEvent returns true for valid event", () => {
  const value = {
    schema: "adjutant.event.v1.1",
    uid: "slack:C123@1730000000.123",
    source: "slack",
    kind: "post",
    ts: "2026-03-01T10:00:00.000Z",
    detail: {
      slack: {
        channel_id: "C123",
        message_ts: "1730000000.123",
        text: "hello",
      },
    },
  };

  assert.equal(isNormalizedEvent(value), true);
  assert.equal(isSlackNormalizedEvent(value), true);
});

test("isNormalizedEvent returns false when schema is missing", () => {
  const value = {
    uid: "slack:C123@1730000000.123",
    source: "slack",
    kind: "post",
    ts: "2026-03-01T10:00:00.000Z",
  };

  assert.equal(isNormalizedEvent(value), false);
});

test("isSlackNormalizedEvent returns false for non-slack source", () => {
  const value = {
    schema: "adjutant.event.v1.1",
    uid: "github:repo@1",
    source: "github",
    kind: "push",
    ts: "2026-03-01T10:00:00.000Z",
  };

  assert.equal(isNormalizedEvent(value), true);
  assert.equal(isSlackNormalizedEvent(value), false);
});
