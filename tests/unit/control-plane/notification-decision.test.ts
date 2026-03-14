import assert from "node:assert/strict";
import test from "node:test";

import {
  buildNotificationDecisionPrompt,
  parseNotificationDecision,
} from "../../../src/control-plane/notification-decision.js";
import type { IngestProjection } from "../../../src/control-plane/process-rpc/ingest-projection.js";

const projection: IngestProjection = {
  sessionKey: "slack-activity",
  message: "ignored",
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
        workspace_host: "example.slack.com",
        channel_id: "C1",
        notification_type: "mention",
        title: "title",
        message_text: "hello",
        message_ts: "1773.1",
        permalink: "https://example.slack.com/archives/C1/p17731",
      },
    },
  },
};

test("parseNotificationDecision は JSON を正規化する", () => {
  const decision = parseNotificationDecision(
    JSON.stringify({
      action: "draft_reply",
      reason: "direct ask",
      replyText: "確認します",
    })
  );

  assert.deepEqual(decision, {
    action: "draft_reply",
    reason: "direct ask",
    replyText: "確認します",
  });
});

test("parseNotificationDecision は不正な応答を needs_review に倒す", () => {
  const decision = parseNotificationDecision("plain text only");
  assert.equal(decision.action, "needs_review");
  assert.equal(decision.reviewNotes, "plain text only");
});

test("parseNotificationDecision は play_slack_search 失敗時に needs_review へ倒す", () => {
  const decision = parseNotificationDecision(
    JSON.stringify({
      action: "draft_reply",
      reason: "context available",
      replyText: "確認します",
    }),
    {
      toolCalls: [
        {
          toolName: "play_slack_search",
          status: "failed",
          result: "timeout after 180000ms",
        },
      ],
    }
  );

  assert.deepEqual(decision, {
    action: "needs_review",
    reason: "context available",
    replyText: "確認します",
    reviewNotes: "play_slack_search failed: timeout after 180000ms",
  });
});

test("parseNotificationDecision は permalink fallback 失敗を needs_review として保持する", () => {
  const decision = parseNotificationDecision(
    JSON.stringify({
      action: "no_action",
      reason: "informational",
    }),
    {
      toolCalls: [
        {
          toolName: "play_slack_search",
          status: "failed",
          result: "failed to derive permalink for mode=thread",
        },
      ],
    }
  );

  assert.deepEqual(decision, {
    action: "needs_review",
    reason: "informational",
    reviewNotes: "play_slack_search failed: failed to derive permalink for mode=thread",
  });
});

test("buildNotificationDecisionPrompt は通知 anchor を含む", () => {
  const prompt = buildNotificationDecisionPrompt(projection);
  assert.match(prompt, /channelId: C1/);
  assert.match(prompt, /messageTs: 1773.1/);
  assert.match(prompt, /permalink: https:\/\/example\.slack\.com\/archives\/C1\/p17731/);
  assert.match(prompt, /workspaceUrl: https:\/\/example\.slack\.com/);
  assert.match(prompt, /Return JSON only/);
  assert.match(
    prompt,
    /call play_slack_search with \{"mode":"message","channelId":"C1","messageTs":"1773\.1","permalink":"https:\/\/example\.slack\.com\/archives\/C1\/p17731","workspaceUrl":"https:\/\/example\.slack\.com"\}/
  );
  assert.match(
    prompt,
    /If play_slack_search fails, times out, or returns insufficient context, respond with action=needs_review/
  );
});

test("buildNotificationDecisionPrompt は threadTs がある場合 thread mode を優先する", () => {
  const prompt = buildNotificationDecisionPrompt({
    ...projection,
    rawEvent: {
      ...projection.rawEvent,
      detail: {
        slack: {
          workspace_host: "example.slack.com",
          channel_id: "C1",
          notification_type: "mention",
          message_text: "hello",
          message_ts: "1773.1",
          thread_ts: "1773.0",
          permalink: "https://example.slack.com/archives/C1/p17731",
        },
      },
    },
  });

  assert.match(
    prompt,
    /call play_slack_search with \{"mode":"thread","channelId":"C1","threadTs":"1773\.0","permalink":"https:\/\/example\.slack\.com\/archives\/C1\/p17731","workspaceUrl":"https:\/\/example\.slack\.com"\}/
  );
});
