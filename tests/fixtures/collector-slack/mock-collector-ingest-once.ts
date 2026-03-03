const delayMs = Number.parseInt(process.env.ADJUTANT_TEST_COLLECTOR_DELAY_MS ?? "1200", 10);

const ingestRequest = {
  jsonrpc: "2.0",
  id: "ing_fixture_1",
  method: "collector/ingest",
  params: {
    messageId: "msg_collector_fixture_1",
    dedupeKey: "slack:C123@1730000000.123",
    source: "slack",
    occurredAt: "2026-03-03T12:00:00.000Z",
    payload: {
      schema: "adjutant.event.v1.1",
      uid: "slack:C123@1730000000.123",
      source: "slack",
      kind: "post",
      ts: "2026-03-03T12:00:00.000Z",
      detail: {
        slack: {
          channel_id: "C123",
          message_ts: "1730000000.123",
          text: "collector fixture message",
        },
      },
    },
  },
};

process.stdin.setEncoding("utf8");
process.stdin.on("data", () => {
  // ignore response lines from control-plane in fixture collector
});

setTimeout(
  () => {
    process.stdout.write(`${JSON.stringify(ingestRequest)}\n`);
  },
  Number.isFinite(delayMs) && delayMs > 0 ? delayMs : 1200
);

setInterval(() => {}, 10_000);
