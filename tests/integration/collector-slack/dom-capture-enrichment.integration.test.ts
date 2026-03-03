import assert from "node:assert/strict";
import test from "node:test";

import type { NormalizedEvent } from "../../../src/core/events.js";
import { enrichReactionEventWithDomCapture } from "../../../src/collector-slack/dom-capture-enrichment.js";

test("reaction stream integration: DOM capture success/failure を混在させても安全に補完できる", () => {
  const base: NormalizedEvent = {
    schema: "adjutant.event.v1.1",
    uid: "slack:C123@1730000000.123:thumbsup:added:U123",
    source: "slack",
    kind: "reaction",
    action: "added",
    ts: "2026-03-01T10:00:00.000Z",
    detail: {
      slack: {
        channel_id: "C123",
        message_ts: "1730000000.123",
        emoji: "thumbsup",
      },
    },
  };

  const pass1 = enrichReactionEventWithDomCapture(base, null);
  const pass2 = enrichReactionEventWithDomCapture(pass1, { text: "captured text" });
  const pass3 = enrichReactionEventWithDomCapture(pass2, { text: "" });

  const slack = (pass3.detail as { slack: Record<string, unknown> }).slack;
  assert.equal(slack.message_text, "captured text");
});
