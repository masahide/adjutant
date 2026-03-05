import assert from "node:assert/strict";
import test from "node:test";

import { STREAM_EVENT_TYPES } from "../../../src/control-plane/contracts/http-api.js";

test("SSE StreamEvent names follow ACP slash naming convention", () => {
  assert.equal(STREAM_EVENT_TYPES.length > 0, true);
  for (const eventName of STREAM_EVENT_TYPES) {
    if (eventName === "heartbeat") {
      continue;
    }
    assert.equal(eventName.includes("/"), true, `${eventName} must include slash separator`);
    assert.equal(eventName.includes("."), false, `${eventName} must not include dot separator`);
  }
});
