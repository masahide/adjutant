import assert from "node:assert/strict";
import test from "node:test";

import { buildCollectorDispatchPayload } from "../../../../src/control-plane/proactive/dispatch-payload.js";
import type { IngestProjection } from "../../../../src/control-plane/process-rpc/ingest-projection.js";

test("notification dispatch payload は decision prompt を使う", () => {
  const projection: IngestProjection = {
    sessionKey: "slack-activity",
    message: "legacy-message",
    dedupeKey: "dedupe-1",
    source: "slack",
    occurredAt: "2026-03-14T10:00:00.000Z",
    rawEvent: {
      schema: "adjutant.event.v1.1",
      uid: "notif-1",
      source: "slack",
      kind: "notification",
      ts: "2026-03-14T10:00:00.000Z",
      subject: "subject",
      detail: {
        slack: {
          channel_id: "C1",
          notification_type: "mention",
          message_text: "hello",
        },
      },
    },
  };

  const payload = buildCollectorDispatchPayload([projection]);
  assert.equal(payload.sessionKey, "slack-activity");
  assert.equal(payload.idempotencyKey, "dedupe-1");
  assert.match(payload.message, /Return JSON only/);
  assert.match(payload.message, /play_slack_search/);
  assert.doesNotMatch(payload.message, /legacy-message/);
});

test("non-notification dispatch payload は既存 message を使う", () => {
  const projection: IngestProjection = {
    sessionKey: "main",
    message: "legacy-message",
    dedupeKey: "dedupe-1",
    source: "slack",
    occurredAt: "2026-03-14T10:00:00.000Z",
    rawEvent: {
      schema: "adjutant.event.v1.1",
      uid: "post-1",
      source: "slack",
      kind: "post",
      ts: "2026-03-14T10:00:00.000Z",
      subject: "subject",
      detail: {
        slack: {
          channel_id: "C1",
          text: "hello",
        },
      },
    },
  };

  const payload = buildCollectorDispatchPayload([projection]);
  assert.equal(payload.message, "legacy-message");
});
