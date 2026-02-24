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
  debugCookieStoreEnabled?: boolean;
  readCookieStore?: (
    requestUrl: string
  ) => Promise<Array<{ name: string; value: string; domain?: string; path?: string }>>;
  onDebugEvent?: (payload: unknown) => void;
}) => {
  const cache = new Map<string, { text?: string; user?: string; teamId?: string }>();
  const domCaptureCalls: unknown[] = [];

  const handlers = new SlackIngressHandlers({
    now: () => new Date("2024-03-22T12:45:00Z"),
    timezone: "Asia/Tokyo",
    slackApiRe: /https:\/\/[^/]+\.slack\.com\/api\/(chat\.postMessage|reactions\.[a-z]+)/i,
    debugFetchHookEnabled: options?.debugFetchHookEnabled ?? false,
    debugCookieStoreEnabled: options?.debugCookieStoreEnabled ?? false,
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
    readCookieStore: options?.readCookieStore,
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
        headers: {
          "content-type": "application/json",
          authorization: "Bearer xoxc-123-456-789-abcdef123456",
          cookie: "d=xoxd-aaa%2Bbbb; other=1",
        },
        postData: JSON.stringify({ text: "debug sample" }),
      },
    });

    assert.equal(debugEvents.length, 1);
    const debugPayload = debugEvents[0] as
      | {
          stage?: string;
          authDebug?: {
            xoxc?: { detected?: boolean };
            xoxd?: { detected?: boolean };
            cookieD?: { present?: boolean };
          };
          cacheUpdate?: {
            workspaceKey?: string;
            tokens?: Array<{
              tokenKind?: string;
              updated?: boolean;
              hits?: number;
            }>;
          } | null;
        }
      | undefined;
    assert.equal(debugPayload?.stage, "requestWillBeSent");
    assert.equal(debugPayload?.authDebug?.xoxc?.detected, true);
    assert.equal(debugPayload?.authDebug?.xoxd?.detected, true);
    assert.equal(debugPayload?.authDebug?.cookieD?.present, true);
    assert.equal(debugPayload?.cacheUpdate?.workspaceKey, "example");
    assert.equal(debugPayload?.cacheUpdate?.tokens?.[0]?.tokenKind, "xoxc");
    assert.equal(debugPayload?.cacheUpdate?.tokens?.[0]?.updated, true);
    assert.equal(debugPayload?.cacheUpdate?.tokens?.[0]?.hits, 1);
    assert.equal(debugPayload?.cacheUpdate?.tokens?.[1]?.tokenKind, "xoxd");
  });

  it("requestPaused の raw_fetch debug に authDebug を含める", async () => {
    const debugEvents: unknown[] = [];
    const { handlers } = createHandlers({
      onDebugEvent: (payload) => debugEvents.push(payload),
    });

    await handlers.handleRequest({
      requestId: "req-4",
      frameId: "F4",
      request: {
        url: "https://example.slack.com/api/chat.postMessage",
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer xoxc-111-222-333-aaaaaaaaaaaaaaaa",
          cookie: "foo=bar; d=xoxd-111%2B222",
        },
        postData: JSON.stringify({
          channel: "C123",
          text: "hello",
          token: "xoxc-999-888-777-cccccccccccccccc",
        }),
      },
    });

    const debugPayload = debugEvents.find((payload) => {
      if (!payload || typeof payload !== "object") return false;
      return (payload as { stage?: string }).stage === "requestPaused";
    }) as
      | {
          authDebug?: {
            xoxc?: { detected?: boolean };
            xoxd?: { detected?: boolean };
            cookieD?: { present?: boolean };
          };
        }
      | undefined;
    assert.ok(debugPayload, "requestPaused debug payload should be emitted");
    assert.equal(debugPayload?.authDebug?.xoxc?.detected, true);
    assert.equal(debugPayload?.authDebug?.xoxd?.detected, true);
    assert.equal(debugPayload?.authDebug?.cookieD?.present, true);
  });

  it("requestWillBeSentExtraInfo は associatedCookies を明示出力する", async () => {
    const debugEvents: unknown[] = [];
    const { handlers } = createHandlers({
      debugFetchHookEnabled: true,
      onDebugEvent: (payload) => debugEvents.push(payload),
    });

    await handlers.handleRequestWillBeSent({
      requestId: "req-extra-1",
      type: "Fetch",
      request: {
        url: "https://example.slack.com/api/chat.postMessage",
        method: "POST",
      },
    });
    await handlers.handleRequestWillBeSentExtraInfo({
      requestId: "req-extra-1",
      headers: {},
      associatedCookies: [{ cookie: { name: "d", value: "xoxd-associated%2Btoken" } }],
    });

    const debugPayload = debugEvents.find((payload) => {
      if (!payload || typeof payload !== "object") return false;
      return (payload as { stage?: string }).stage === "requestWillBeSentExtraInfo";
    }) as
      | {
          dCookieFromAssociated?: string | null;
          authDebug?: {
            cookieD?: { value?: string | null };
            xoxd?: { detected?: boolean };
          };
          cacheUpdate?: {
            workspaceKey?: string;
            sourceStage?: string;
            tokens?: Array<{
              tokenKind?: string;
              updated?: boolean;
              hits?: number;
            }>;
          } | null;
        }
      | undefined;
    assert.ok(debugPayload, "requestWillBeSentExtraInfo debug payload should be emitted");
    assert.equal(debugPayload?.dCookieFromAssociated, "xoxd-associated%2Btoken");
    assert.equal(debugPayload?.authDebug?.cookieD?.value, "xoxd-associated%2Btoken");
    assert.equal(debugPayload?.authDebug?.xoxd?.detected, true);
    assert.equal(debugPayload?.cacheUpdate?.workspaceKey, "example");
    assert.equal(debugPayload?.cacheUpdate?.sourceStage, "requestWillBeSentExtraInfo");
    assert.equal(debugPayload?.cacheUpdate?.tokens?.[0]?.tokenKind, "xoxd");
    assert.equal(debugPayload?.cacheUpdate?.tokens?.[0]?.updated, true);
    assert.equal(debugPayload?.cacheUpdate?.tokens?.[0]?.hits, 1);
  });

  it("debugCookieStoreEnabled=true の時だけ cookieStoreSnapshot を別イベントで出力する", async () => {
    const debugEvents: unknown[] = [];
    const { handlers } = createHandlers({
      debugFetchHookEnabled: true,
      debugCookieStoreEnabled: true,
      readCookieStore: async () => [{ name: "d", value: "xoxd-store%2Btoken" }],
      onDebugEvent: (payload) => debugEvents.push(payload),
    });

    await handlers.handleRequestWillBeSent({
      requestId: "req-extra-2",
      type: "Fetch",
      request: {
        url: "https://example.slack.com/api/chat.postMessage",
        method: "POST",
      },
    });
    await handlers.handleRequestWillBeSentExtraInfo({
      requestId: "req-extra-2",
      headers: {},
    });

    const cookieStorePayload = debugEvents.find((payload) => {
      if (!payload || typeof payload !== "object") return false;
      return (payload as { stage?: string }).stage === "cookieStoreSnapshot";
    }) as
      | {
          dCookieFromStore?: string | null;
          authDebug?: {
            cookieD?: { value?: string | null };
            xoxd?: { detected?: boolean };
          };
          cacheUpdate?: {
            workspaceKey?: string;
            sourceStage?: string;
            tokens?: Array<{
              tokenKind?: string;
              updated?: boolean;
              hits?: number;
            }>;
          } | null;
        }
      | undefined;
    assert.ok(cookieStorePayload, "cookieStoreSnapshot payload should be emitted");
    assert.equal(cookieStorePayload?.dCookieFromStore, "xoxd-store%2Btoken");
    assert.equal(cookieStorePayload?.authDebug?.cookieD?.value, "xoxd-store%2Btoken");
    assert.equal(cookieStorePayload?.authDebug?.xoxd?.detected, true);
    assert.equal(cookieStorePayload?.cacheUpdate?.workspaceKey, "example");
    assert.equal(cookieStorePayload?.cacheUpdate?.sourceStage, "cookieStoreSnapshot");
    assert.equal(cookieStorePayload?.cacheUpdate?.tokens?.[0]?.tokenKind, "xoxd");
    assert.equal(cookieStorePayload?.cacheUpdate?.tokens?.[0]?.updated, true);
  });

  it("同一 token の再観測時は cacheUpdate.updated=false かつ hits が増える", async () => {
    const debugEvents: unknown[] = [];
    const { handlers } = createHandlers({
      debugFetchHookEnabled: true,
      onDebugEvent: (payload) => debugEvents.push(payload),
    });

    await handlers.handleRequestWillBeSent({
      requestId: "req-repeat-1",
      type: "Fetch",
      request: {
        url: "https://workspace.slack.com/api/chat.postMessage",
        method: "POST",
        headers: { authorization: "Bearer xoxc-123-456-789-abcdef123456" },
      },
    });
    await handlers.handleRequestWillBeSent({
      requestId: "req-repeat-2",
      type: "Fetch",
      request: {
        url: "https://workspace.slack.com/api/chat.postMessage",
        method: "POST",
        headers: { authorization: "Bearer xoxc-123-456-789-abcdef123456" },
      },
    });

    const second = debugEvents
      .filter((payload) => payload && typeof payload === "object")
      .map((payload) => payload as { stage?: string; cacheUpdate?: { tokens?: unknown[] } | null })
      .filter((payload) => payload.stage === "requestWillBeSent")[1];
    const token = (second?.cacheUpdate?.tokens?.[0] as { updated?: boolean; hits?: number }) ?? {};
    assert.equal(token.updated, false);
    assert.equal(token.hits, 2);
  });
});
