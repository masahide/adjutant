import { writeFile } from "node:fs/promises";

const delayMs = Number.parseInt(process.env.ADJUTANT_TEST_COLLECTOR_DELAY_MS ?? "1200", 10);
const responseAckPath = process.env.ADJUTANT_TEST_COLLECTOR_RESPONSE_ACK_PATH?.trim();

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

let responseBuffer = "";
let wroteAck = false;

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  responseBuffer += chunk;

  let newlineIndex = responseBuffer.indexOf("\n");
  while (newlineIndex >= 0) {
    const line = responseBuffer.slice(0, newlineIndex).trim();
    responseBuffer = responseBuffer.slice(newlineIndex + 1);
    if (line.length > 0) {
      try {
        const parsed = JSON.parse(line) as {
          id?: string;
          result?: { status?: string; messageId?: string };
          error?: unknown;
        };
        if (
          !wroteAck &&
          responseAckPath !== undefined &&
          parsed.id === "ing_fixture_1" &&
          (parsed.result !== undefined || parsed.error !== undefined)
        ) {
          wroteAck = true;
          void writeFile(
            responseAckPath,
            `${JSON.stringify({
              id: parsed.id,
              status: parsed.result?.status,
              messageId: parsed.result?.messageId,
              hasError: parsed.error !== undefined,
            })}\n`,
            "utf8"
          );
        }
      } catch {
        // ignore non-JSON lines from parent process
      }
    }
    newlineIndex = responseBuffer.indexOf("\n");
  }
});

setTimeout(
  () => {
    process.stdout.write(`${JSON.stringify(ingestRequest)}\n`);
  },
  Number.isFinite(delayMs) && delayMs > 0 ? delayMs : 1200
);

setInterval(() => {}, 10_000);
