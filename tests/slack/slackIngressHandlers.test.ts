import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SlackNameCacheRepository } from "../../src/slack/nameCacheRepository.js";
import { ResponseBodyReader } from "../../src/slack/responseBodyReader.js";
import { SlackResponseProjector } from "../../src/slack/responseProjector.js";
import { SlackDebug } from "../../src/slack/slackDebug.js";
import { SlackIngressHandlers } from "../../src/slack/slackIngressHandlers.js";

const createHandlers = (options?: {
  responseBodyByRequestId?: Record<string, string>;
  debugFetchHookEnabled?: boolean;
  onDebugEvent?: (payload: unknown) => void;
}) => {
  const cache = new Map<string, { text?: string; user?: string; teamId?: string }>();
  const domCaptureCalls: unknown[] = [];

  const handlers = new SlackIngressHandlers({
    now: () => new Date("2024-03-22T12:45:00Z"),
    timezone: "Asia/Tokyo",
    slackApiRe: /https:\/\/[^/]+\.slack\.com\/api\/(chat\.postMessage|reactions\.[a-z]+)/i,
    debugFetchHookEnabled: options?.debugFetchHookEnabled ?? false,
    debugNotificationEnabled: false,
    slackDebug: new SlackDebug({ prefix: "Test", enabled: false }),
    pushDebugEvent: (_kind, payload) => {
      options?.onDebugEvent?.(payload);
    },
    truncateForDebug: (value) => value,
    domCapture: {
      capture: async (candidate) => {
        domCaptureCalls.push(candidate);
      },
      consume: () => ({ text: "captured from dom", channelId: "C123", channelName: "general" }),
    },
    cache,
    cacheMessage: (channel, ts, value) => {
      cache.set(`${channel}@${ts}`, {
        text: value.text ?? undefined,
        user: value.user ?? undefined,
        teamId: value.teamId ?? undefined,
      });
    },
    cacheKey: (channel, ts) => `${channel}@${ts}`,
    resolveChannelNameFromMap: (channelId) => channelId ?? undefined,
    resolveTeamId: (teamIdHint) => teamIdHint,
    resolveUserNameFromMap: (userId) => userId ?? undefined,
    nameCacheRepository: new SlackNameCacheRepository(),
    responseBodyReader: new ResponseBodyReader({
      Network: {
        getResponseBody: async ({ requestId }: { requestId: string }) => ({
          body: options?.responseBodyByRequestId?.[requestId] ?? "",
          base64Encoded: false,
        }),
      },
    } as never),
    responseProjector: new SlackResponseProjector(),
  });

  return { handlers, domCaptureCalls, cache };
};

describe("SlackIngressHandlers", () => {
  it("reactions.add の Fetch を処理して normalized reaction を返す", async () => {
    const { handlers, domCaptureCalls } = createHandlers();

    const result = await handlers.handleRequest({
      requestId: "req-1",
      frameId: "F1",
      request: {
        url: "https://example.slack.com/api/reactions.add",
        method: "POST",
        headers: { "content-type": "application/json" },
        postData: JSON.stringify({
          channel: "C123",
          timestamp: "1711112222.000300",
          name: "eyes",
          user: "U123",
        }),
      },
    });

    assert.equal(result.length, 1);
    assert.equal(result[0]?.kind, "reaction");
    const detail = result[0]?.detail as { slack?: { message_text?: string } };
    assert.equal(detail?.slack?.message_text, "captured from dom");
    assert.equal(domCaptureCalls.length, 1);
  });

  it("WebSocket 受信 payload から notification 候補を抽出する", async () => {
    const { handlers } = createHandlers();

    const events = await handlers.handleWebSocketFrame(
      {
        response: {
          payloadData: JSON.stringify({
            type: "message",
            subtype: "bot_message",
            channel: "C123",
            ts: "1711113333.000400",
            bot_id: "B123",
            text: "bot notification",
          }),
        },
      },
      "received"
    );

    assert.equal(events.length, 1);
    assert.equal(events[0]?.kind, "notification");
  });

  it("responseReceived で chat.postMessage の response body を message cache に反映する", async () => {
    const { handlers, cache } = createHandlers({
      responseBodyByRequestId: {
        "req-2": JSON.stringify({
          ok: true,
          message: {
            channel: "C321",
            ts: "1711117777.000100",
            blocks: [{ type: "section", text: { type: "mrkdwn", text: "hello cache" } }],
            user: "U321",
          },
        }),
      },
    });

    await handlers.handleResponseReceived({
      requestId: "req-2",
      response: {
        url: "https://example.slack.com/api/chat.postMessage",
      },
    });

    assert.equal(cache.has("C321@1711117777.000100"), true);
  });

  it("requestWillBeSent は debugFetchHookEnabled=true の時だけ raw_fetch debug を送る", async () => {
    const debugEvents: unknown[] = [];
    const { handlers } = createHandlers({
      debugFetchHookEnabled: true,
      onDebugEvent: (payload) => debugEvents.push(payload),
    });

    await handlers.handleRequestWillBeSent({
      requestId: "req-3",
      type: "Fetch",
      request: {
        url: "https://example.slack.com/api/chat.postMessage",
        method: "POST",
        headers: { "content-type": "application/json" },
        postData: JSON.stringify({ text: "debug sample" }),
      },
    });

    assert.equal(debugEvents.length, 1);
    assert.equal((debugEvents[0] as { stage?: string } | undefined)?.stage, "requestWillBeSent");
  });
});
