const delayMs = Number.parseInt(process.env.ADJUTANT_TEST_COLLECTOR_DELAY_MS ?? "1200", 10);

const ingestRequest = {
  jsonrpc: "2.0",
  id: "ing_notification_fixture_1",
  method: "collector/ingest",
  params: {
    messageId: "msg_collector_notification_fixture_1",
    dedupeKey: "slack-notification:CTESTCHN01@1773481739.636659",
    source: "slack",
    occurredAt: "2026-03-14T17:00:00.000Z",
    payload: {
      schema: "adjutant.event.v1.1",
      uid: "slack-notification:CTESTCHN01@1773481739.636659",
      source: "slack",
      kind: "notification",
      ts: "2026-03-14T17:00:00.000Z",
      subject: "workflow mention",
      detail: {
        slack: {
          team_id: "TTEAM0001",
          channel_id: "CTESTCHN01",
          notification_type: "mention",
          title: "Untitled Workflow",
          message_text: "<@UTEST0001> test",
          message_ts: "1773481739.636659",
          permalink: "https://workspace-alpha.slack.com/archives/CTESTCHN01/p1773481739636659",
          mention_target_user_id: "UTEST0001",
          is_direct_mention: true,
        },
      },
    },
  },
};

setTimeout(
  () => {
    process.stdout.write(`${JSON.stringify(ingestRequest)}\n`);
  },
  Number.isFinite(delayMs) && delayMs > 0 ? delayMs : 1200
);

setInterval(() => {}, 10_000);
