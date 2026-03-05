import assert from "node:assert/strict";
import test from "node:test";

import { createRuleTriage } from "../../../../src/control-plane/proactive/rule-triage.js";
import type { NormalizedEvent } from "../../../../src/core/events.js";

function createEvent(input: { channelId: string; text?: string; actor?: string }): NormalizedEvent {
  return {
    schema: "adjutant.event.v1.1",
    uid: `slack:${input.channelId}@1730000000.100`,
    source: "slack",
    kind: "post",
    actor: input.actor,
    ts: "2026-03-05T00:00:00.000Z",
    detail: {
      slack: {
        channel_id: input.channelId,
        message_ts: "1730000000.100",
        text: input.text ?? "hello",
      },
    },
  };
}

test("DM は immediate になる", () => {
  const triage = createRuleTriage();
  const result = triage.classify({
    sessionKey: "slack:D123",
    event: createEvent({ channelId: "D123" }),
  });
  assert.equal(result.route, "immediate");
  assert.equal(result.source, "dm");
});

test("mention は immediate になる", () => {
  const triage = createRuleTriage();
  const result = triage.classify({
    sessionKey: "slack:channel:C123",
    event: createEvent({ channelId: "C123", text: "ping <@U_SELF>" }),
  });
  assert.equal(result.route, "immediate");
  assert.equal(result.reason, "mention");
});

test("self 投稿は drop になる", () => {
  const triage = createRuleTriage({ selfUserId: "U_SELF" });
  const result = triage.classify({
    sessionKey: "slack:channel:C123",
    event: createEvent({ channelId: "C123", actor: "U_SELF" }),
  });
  assert.equal(result.route, "drop");
  assert.equal(result.reason, "self-message");
});

test("通常 channel post は accumulate になる", () => {
  const triage = createRuleTriage();
  const result = triage.classify({
    sessionKey: "slack:channel:C123",
    event: createEvent({ channelId: "C123", text: "regular post" }),
  });
  assert.equal(result.route, "accumulate");
  assert.equal(result.source, "channel");
});
