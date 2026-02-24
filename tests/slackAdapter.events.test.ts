import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { SlackAdapter } from "../src/slack/adapter.js";
import type { NormalizedEvent } from "../src/core/events.js";
import { createMockSlackClient } from "./mockSlackClient.js";

describe("SlackAdapter event handling", () => {
  it("WebSocketキャッシュとFetchイベントを組み合わせて正規化する", async () => {
    const mock = createMockSlackClient();
    const emitted: NormalizedEvent[] = [];
    const adapter = new SlackAdapter({
      client: mock.client,
      now: () => new Date("2024-03-22T12:45:00Z"),
    });

    await adapter.start(async (ev) => {
      emitted.push(ev);
    });

    await mock.triggerNetwork("webSocketFrameReceived", {
      response: {
        payloadData: JSON.stringify({
          type: "message",
          channel: "C999",
          ts: "1711115555.000600",
          blocks: [{ type: "rich_text", elements: [] }],
          user: "U222",
        }),
      },
    });

    await mock.triggerFetch({
      requestId: "req-2",
      request: {
        url: "https://workspace.slack.com/api/reactions.add",
        method: "POST",
        headers: { "content-type": "application/json" },
        postData: JSON.stringify({
          channel: "C999",
          timestamp: "1711115555.000600",
          name: "thumbsup",
        }),
      },
    });

    assert.equal(emitted.length, 1);
    const reaction = emitted[0];
    assert.equal(reaction.kind, "reaction");
    assert.equal(reaction.action, "added");
    assert.equal(reaction.meta?.emoji, "thumbsup");
    const detail = reaction.detail;
    assert.ok(detail && "slack" in detail);
    const slackDetail = detail.slack as {
      channel_id: string;
      emoji?: string;
      message_text?: string;
    };
    assert.equal(slackDetail.channel_id, "C999");
    assert.equal(slackDetail.emoji, "thumbsup");
    assert.equal(slackDetail.message_text, "");
    assert.equal(reaction.actor, "U222", "WebSocketキャッシュからactorを補完する");
    assert.equal(reaction.uid, "slack:C999@1711115555.000600:thumbsup:added:U222");
  });

  it("WebSocket通知イベントをnotificationとして記録する", async () => {
    const mock = createMockSlackClient();
    const emitted: NormalizedEvent[] = [];
    const tempRoot = await mkdtemp(path.join(tmpdir(), "adjutant-notification-cache-"));
    const channelCachePath = path.join(tempRoot, "_cache", "slack", "channel-names-by-team.json");
    const userCachePath = path.join(tempRoot, "_cache", "slack", "user-names-by-team.json");
    await mkdir(path.join(tempRoot, "_cache", "slack", "channel-names-by-team"), {
      recursive: true,
    });
    await mkdir(path.join(tempRoot, "_cache", "slack", "user-names-by-team"), { recursive: true });
    await writeFile(
      path.join(tempRoot, "_cache", "slack", "channel-names-by-team", "T1.json"),
      `${JSON.stringify(
        {
          schema: "adjutant.slack.channel-cache.v1",
          team_id: "T1",
          channels: { C999: "general" },
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    await writeFile(
      path.join(tempRoot, "_cache", "slack", "user-names-by-team", "T1.json"),
      `${JSON.stringify(
        {
          schema: "adjutant.slack.user-cache.v2",
          team_id: "T1",
          users: {
            U333: {
              profile: {
                display_name: "alice",
              },
            },
          },
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    const adapter = new SlackAdapter({
      client: mock.client,
      now: () => new Date("2024-03-22T12:45:00Z"),
      channelCachePath,
      userCachePath,
    });

    await adapter.start(async (ev) => {
      emitted.push(ev);
    });

    await mock.triggerNetwork("webSocketFrameReceived", {
      response: {
        payloadData: JSON.stringify({
          type: "desktop_notification",
          channel: "C999",
          channel_name: "from-payload-should-be-ignored",
          user: "U333",
          username: "payload-user-ignored",
          team: "T1",
          ts: "1711117777.000800",
          title: "mention",
          text: "hello from mention",
        }),
      },
    });

    assert.equal(emitted.length, 1);
    const notification = emitted[0];
    assert.equal(notification.kind, "notification");
    assert.equal(notification.meta?.notification_type, "desktop_notification");
    assert.equal(notification.meta?.channel, "#general");
    assert.equal(notification.actor, "alice");
    const detail = notification.detail;
    assert.ok(detail && "slack" in detail);
    const slackDetail = detail.slack as {
      channel_id?: string;
      notification_type?: string;
      title?: string;
      message_text?: string;
    };
    assert.equal(slackDetail.channel_id, "C999");
    assert.equal(slackDetail.notification_type, "desktop_notification");
    assert.equal(slackDetail.title, "mention");
    assert.equal(slackDetail.message_text, "hello from mention");
  });

  it("ネストされた通知payloadをnotificationとして記録する", async () => {
    const mock = createMockSlackClient();
    const emitted: NormalizedEvent[] = [];
    const tempRoot = await mkdtemp(path.join(tmpdir(), "adjutant-notification-cache-"));
    const channelCachePath = path.join(tempRoot, "_cache", "slack", "channel-names-by-team.json");
    await mkdir(path.join(tempRoot, "_cache", "slack", "channel-names-by-team"), {
      recursive: true,
    });
    await writeFile(
      path.join(tempRoot, "_cache", "slack", "channel-names-by-team", "T2.json"),
      `${JSON.stringify(
        {
          schema: "adjutant.slack.channel-cache.v1",
          team_id: "T2",
          channels: { C888: "random" },
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    const adapter = new SlackAdapter({
      client: mock.client,
      now: () => new Date("2024-03-22T12:45:00Z"),
      channelCachePath,
    });

    await adapter.start(async (ev) => {
      emitted.push(ev);
    });

    await mock.triggerNetwork("webSocketFrameReceived", {
      response: {
        payloadData: JSON.stringify({
          type: "event_wrapper",
          payload: {
            event: {
              subtype: "mention_notification",
              channel: "C888",
              channel_name: "payload-name-ignored",
              user_id: "U444",
              team_id: "T2",
              event_ts: "1711118888.000900",
              body: "ping from mention",
            },
          },
        }),
      },
    });

    assert.equal(emitted.length, 1);
    const notification = emitted[0];
    assert.equal(notification.kind, "notification");
    assert.equal(notification.meta?.notification_type, "mention_notification");
    assert.equal(notification.meta?.channel, "#random");
    const detail = notification.detail;
    assert.ok(detail && "slack" in detail);
    const slackDetail = detail.slack as {
      channel_id?: string;
      notification_type?: string;
      message_text?: string;
      user?: string;
    };
    assert.equal(slackDetail.channel_id, "C888");
    assert.equal(slackDetail.notification_type, "mention_notification");
    assert.equal(slackDetail.message_text, "ping from mention");
    assert.equal(slackDetail.user, "U444");
  });

  it("bot_message通知をnotificationとして記録する", async () => {
    const mock = createMockSlackClient();
    const emitted: NormalizedEvent[] = [];
    const adapter = new SlackAdapter({
      client: mock.client,
      now: () => new Date("2024-03-22T12:45:00Z"),
    });

    await adapter.start(async (ev) => {
      emitted.push(ev);
    });

    await mock.triggerNetwork("webSocketFrameReceived", {
      response: {
        payloadData: JSON.stringify({
          type: "message",
          subtype: "bot_message",
          channel: "C777",
          text: "Hello, World!",
          bot_id: "B111",
          bot_name: "testwebhook2",
          suppress_notification: false,
          ts: "1711119999.001000",
        }),
      },
    });

    assert.equal(emitted.length, 1);
    const notification = emitted[0];
    assert.equal(notification.kind, "notification");
    assert.equal(notification.meta?.notification_type, "bot_message");
    assert.equal(notification.meta?.channel, "#C777");
    assert.equal(notification.actor, "testwebhook2");
    const detail = notification.detail;
    assert.ok(detail && "slack" in detail);
    const slackDetail = detail.slack as {
      notification_type?: string;
      message_text?: string;
      user?: string;
    };
    assert.equal(slackDetail.notification_type, "bot_message");
    assert.equal(slackDetail.message_text, "Hello, World!");
    assert.equal(slackDetail.user, "testwebhook2");
  });

  it("fetch hook有効時にrequestWillBeSentをraw_fetchとして出力する", async () => {
    const mock = createMockSlackClient();
    const debugEvents: unknown[] = [];
    const adapter = new SlackAdapter({
      client: mock.client,
      now: () => new Date("2024-03-22T12:45:00Z"),
      debugFetchHookEnabled: true,
      onDebugEvent: (event) => {
        debugEvents.push(event);
      },
    });

    await adapter.start(async () => {});

    await mock.triggerNetwork("requestWillBeSent", {
      requestId: "req-hook-1",
      type: "Fetch",
      initiator: { type: "script" },
      request: {
        url: "https://hooks.slack.com/services/T00/B00/XXX",
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer xoxc-123-456-789-abcdef123456",
          cookie: "d=xoxd-aaa%2Bbbb; path=/",
        },
        postData: '{"text":"hello"}',
      },
    });

    const rawFetch = debugEvents.find((event) => {
      if (!event || typeof event !== "object") return false;
      const record = event as { kind?: string; payload?: { stage?: string } };
      return record.kind === "raw_fetch" && record.payload?.stage === "requestWillBeSent";
    }) as
      | {
          payload?: {
            method?: string;
            url?: string;
            urlInfo?: { host?: string; pathname?: string };
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
          };
        }
      | undefined;
    assert.ok(rawFetch, "raw_fetch event should be emitted");
    assert.equal(rawFetch.payload?.method, "POST");
    assert.equal(rawFetch.payload?.url, "https://hooks.slack.com/services/T00/B00/XXX");
    assert.equal(rawFetch.payload?.urlInfo?.host, "hooks.slack.com");
    assert.equal(rawFetch.payload?.urlInfo?.pathname, "/services/T00/B00/XXX");
    assert.equal(rawFetch.payload?.authDebug?.xoxc?.detected, true);
    assert.equal(rawFetch.payload?.authDebug?.xoxd?.detected, true);
    assert.equal(rawFetch.payload?.authDebug?.cookieD?.present, true);
    assert.equal(rawFetch.payload?.cacheUpdate?.workspaceKey, "global");
    assert.equal(rawFetch.payload?.cacheUpdate?.tokens?.[0]?.tokenKind, "xoxc");
    assert.equal(rawFetch.payload?.cacheUpdate?.tokens?.[1]?.tokenKind, "xoxd");
  });

  it("requestWillBeSentExtraInfo を raw_fetch として出力し、getCookies 無効時は cookieStoreSnapshot を出さない", async () => {
    const mock = createMockSlackClient();
    const debugEvents: unknown[] = [];
    const requestUrl = "https://workspace.slack.com/api/chat.postMessage";
    mock.cookieStoreByUrl[requestUrl] = [{ name: "d", value: "xoxd-cookie-store%2Bvalue" }];
    const adapter = new SlackAdapter({
      client: mock.client,
      now: () => new Date("2024-03-22T12:45:00Z"),
      debugFetchHookEnabled: true,
      debugCookieStoreEnabled: false,
      onDebugEvent: (event) => {
        debugEvents.push(event);
      },
    });

    await adapter.start(async () => {});

    await mock.triggerNetwork("requestWillBeSent", {
      requestId: "req-hook-extra-1",
      type: "Fetch",
      request: {
        url: requestUrl,
        method: "POST",
      },
    });
    await mock.triggerNetwork("requestWillBeSentExtraInfo", {
      requestId: "req-hook-extra-1",
      headers: {},
      associatedCookies: [{ cookie: { name: "d", value: "xoxd-associated%2Bvalue" } }],
    });

    const extraInfoEvent = debugEvents.find((event) => {
      if (!event || typeof event !== "object") return false;
      const record = event as { kind?: string; payload?: { stage?: string } };
      return record.kind === "raw_fetch" && record.payload?.stage === "requestWillBeSentExtraInfo";
    }) as
      | {
          payload?: {
            dCookieFromAssociated?: string | null;
            authDebug?: { cookieD?: { value?: string | null } };
            cacheUpdate?: {
              workspaceKey?: string;
              sourceStage?: string;
              tokens?: Array<{
                tokenKind?: string;
                updated?: boolean;
                hits?: number;
              }>;
            } | null;
          };
        }
      | undefined;
    assert.ok(extraInfoEvent, "requestWillBeSentExtraInfo event should be emitted");
    assert.equal(extraInfoEvent.payload?.dCookieFromAssociated, "xoxd-associated%2Bvalue");
    assert.equal(extraInfoEvent.payload?.authDebug?.cookieD?.value, "xoxd-associated%2Bvalue");
    assert.equal(extraInfoEvent.payload?.cacheUpdate?.workspaceKey, "workspace");
    assert.equal(extraInfoEvent.payload?.cacheUpdate?.sourceStage, "requestWillBeSentExtraInfo");
    assert.equal(extraInfoEvent.payload?.cacheUpdate?.tokens?.[0]?.tokenKind, "xoxd");
    assert.equal(extraInfoEvent.payload?.cacheUpdate?.tokens?.[0]?.updated, true);

    const cookieStoreEvent = debugEvents.find((event) => {
      if (!event || typeof event !== "object") return false;
      const record = event as { kind?: string; payload?: { stage?: string } };
      return record.kind === "raw_fetch" && record.payload?.stage === "cookieStoreSnapshot";
    });
    assert.equal(cookieStoreEvent, undefined);
    assert.equal(mock.cookieQueries.length, 0);
  });

  it("debugCookieStoreEnabled=true の時は getCookies を実行して cookieStoreSnapshot を別途出力する", async () => {
    const mock = createMockSlackClient();
    const debugEvents: unknown[] = [];
    const requestUrl = "https://workspace.slack.com/api/chat.postMessage";
    mock.cookieStoreByUrl[requestUrl] = [
      { name: "d", value: "xoxd-cookie-store%2Bvalue" },
      { name: "other", value: "1" },
    ];
    const adapter = new SlackAdapter({
      client: mock.client,
      now: () => new Date("2024-03-22T12:45:00Z"),
      debugFetchHookEnabled: true,
      debugCookieStoreEnabled: true,
      onDebugEvent: (event) => {
        debugEvents.push(event);
      },
    });

    await adapter.start(async () => {});

    await mock.triggerNetwork("requestWillBeSent", {
      requestId: "req-hook-extra-2",
      type: "Fetch",
      request: {
        url: requestUrl,
        method: "POST",
      },
    });
    await mock.triggerNetwork("requestWillBeSentExtraInfo", {
      requestId: "req-hook-extra-2",
      headers: {},
      associatedCookies: [],
    });

    const cookieStoreEvent = debugEvents.find((event) => {
      if (!event || typeof event !== "object") return false;
      const record = event as { kind?: string; payload?: { stage?: string } };
      return record.kind === "raw_fetch" && record.payload?.stage === "cookieStoreSnapshot";
    }) as
      | {
          payload?: {
            dCookieFromStore?: string | null;
            cookieStoreCookiesCount?: number | null;
            authDebug?: { cookieD?: { value?: string | null } };
            cacheUpdate?: {
              workspaceKey?: string;
              sourceStage?: string;
              tokens?: Array<{
                tokenKind?: string;
                updated?: boolean;
                hits?: number;
              }>;
            } | null;
          };
        }
      | undefined;
    assert.ok(cookieStoreEvent, "cookieStoreSnapshot event should be emitted");
    assert.equal(cookieStoreEvent.payload?.dCookieFromStore, "xoxd-cookie-store%2Bvalue");
    assert.equal(cookieStoreEvent.payload?.cookieStoreCookiesCount, 2);
    assert.equal(cookieStoreEvent.payload?.authDebug?.cookieD?.value, "xoxd-cookie-store%2Bvalue");
    assert.equal(cookieStoreEvent.payload?.cacheUpdate?.workspaceKey, "workspace");
    assert.equal(cookieStoreEvent.payload?.cacheUpdate?.sourceStage, "cookieStoreSnapshot");
    assert.equal(cookieStoreEvent.payload?.cacheUpdate?.tokens?.[0]?.tokenKind, "xoxd");
    assert.equal(cookieStoreEvent.payload?.cacheUpdate?.tokens?.[0]?.updated, true);
    assert.deepEqual(mock.cookieQueries, [[requestUrl]]);
  });

  it("fetch hook有効時にresponseReceivedをraw_fetchとして出力する", async () => {
    const mock = createMockSlackClient();
    const debugEvents: unknown[] = [];
    mock.responseBodies["req-hook-res-1"] = {
      base64Encoded: false,
      body: '{"ok":true,"message":"done"}',
    };
    const adapter = new SlackAdapter({
      client: mock.client,
      now: () => new Date("2024-03-22T12:45:00Z"),
      debugFetchHookEnabled: true,
      onDebugEvent: (event) => {
        debugEvents.push(event);
      },
    });

    await adapter.start(async () => {});

    await mock.triggerNetwork("responseReceived", {
      requestId: "req-hook-res-1",
      type: "Fetch",
      response: {
        url: "https://hooks.slack.com/services/T00/B00/XXX",
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json; charset=utf-8" },
      },
    });

    const rawFetch = debugEvents.find((event) => {
      if (!event || typeof event !== "object") return false;
      const record = event as { kind?: string; payload?: { stage?: string } };
      return record.kind === "raw_fetch" && record.payload?.stage === "responseReceived";
    }) as
      | {
          payload?: {
            status?: number;
            bodyType?: string;
            body?: { ok?: boolean };
            urlInfo?: { host?: string; pathname?: string };
          };
        }
      | undefined;
    assert.ok(rawFetch, "raw_fetch response event should be emitted");
    assert.equal(rawFetch.payload?.status, 200);
    assert.equal(rawFetch.payload?.bodyType, "json");
    assert.equal(rawFetch.payload?.body?.ok, true);
    assert.equal(rawFetch.payload?.urlInfo?.host, "hooks.slack.com");
    assert.equal(rawFetch.payload?.urlInfo?.pathname, "/services/T00/B00/XXX");
  });

  it("conversations.view応答でteam別チャンネル名キャッシュを更新する", async () => {
    const mock = createMockSlackClient();
    mock.responseBodies["req-conversations-view-1"] = {
      base64Encoded: false,
      body: JSON.stringify({
        ok: true,
        channel: {
          id: "C0AA05UDGU8",
          name: "テストチャンネル",
          context_team_id: "T0A93QQUMQW",
        },
      }),
    };
    const tempRoot = await mkdtemp(path.join(tmpdir(), "adjutant-channel-cache-"));
    const cachePath = path.join(tempRoot, "_cache", "slack", "channel-names-by-team.json");
    const adapter = new SlackAdapter({
      client: mock.client,
      now: () => new Date("2024-03-22T12:45:00Z"),
      channelCachePath: cachePath,
    });

    await adapter.start(async () => {});

    await mock.triggerNetwork("responseReceived", {
      requestId: "req-conversations-view-1",
      type: "XHR",
      response: {
        url: "https://ys-family-hq.slack.com/api/conversations.view?_x_id=test",
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json; charset=utf-8" },
      },
    });

    const raw = await readFile(
      path.join(tempRoot, "_cache", "slack", "channel-names-by-team", "T0A93QQUMQW.json"),
      "utf8"
    );
    const parsed = JSON.parse(raw) as {
      schema?: string;
      team_id?: string;
      channels?: Record<string, string>;
    };
    assert.equal(parsed.schema, "adjutant.slack.channel-cache.v1");
    assert.equal(parsed.team_id, "T0A93QQUMQW");
    assert.equal(parsed.channels?.C0AA05UDGU8, "テストチャンネル");
  });

  it("cache/channels/info応答でteam別チャンネル名キャッシュを更新する", async () => {
    const mock = createMockSlackClient();
    mock.responseBodies["req-channels-info-1"] = {
      base64Encoded: false,
      body: JSON.stringify({
        ok: true,
        channels: [
          {
            id: "C0AA05UDGU8",
            name: "テストチャンネルA",
          },
          {
            id: "C0AA05UDGU9",
            name: "テストチャンネルB",
          },
        ],
      }),
    };
    const tempRoot = await mkdtemp(path.join(tmpdir(), "adjutant-channel-cache-"));
    const cachePath = path.join(tempRoot, "_cache", "slack", "channel-names-by-team.json");
    const adapter = new SlackAdapter({
      client: mock.client,
      now: () => new Date("2024-03-22T12:45:00Z"),
      channelCachePath: cachePath,
    });

    await adapter.start(async () => {});

    await mock.triggerNetwork("responseReceived", {
      requestId: "req-channels-info-1",
      type: "XHR",
      response: {
        url: "https://edgeapi.slack.com/cache/T0A93QQUMQW/channels/info?_x_app_name=client",
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json; charset=utf-8" },
      },
    });

    const raw = await readFile(
      path.join(tempRoot, "_cache", "slack", "channel-names-by-team", "T0A93QQUMQW.json"),
      "utf8"
    );
    const parsed = JSON.parse(raw) as {
      schema?: string;
      team_id?: string;
      channels?: Record<string, string>;
    };
    assert.equal(parsed.schema, "adjutant.slack.channel-cache.v1");
    assert.equal(parsed.team_id, "T0A93QQUMQW");
    assert.equal(parsed.channels?.C0AA05UDGU8, "テストチャンネルA");
    assert.equal(parsed.channels?.C0AA05UDGU9, "テストチャンネルB");
  });

  it("cache/channels/search応答でteam別チャンネル名キャッシュを更新する", async () => {
    const mock = createMockSlackClient();
    mock.responseBodies["req-channels-search-1"] = {
      base64Encoded: false,
      body: JSON.stringify({
        ok: true,
        results: [
          {
            id: "C0AA05UDSX1",
            name: "検索チャンネルA",
          },
          {
            id: "C0AA05UDSX2",
            name: "検索チャンネルB",
          },
        ],
      }),
    };
    const tempRoot = await mkdtemp(path.join(tmpdir(), "adjutant-channel-cache-"));
    const cachePath = path.join(tempRoot, "_cache", "slack", "channel-names-by-team.json");
    const adapter = new SlackAdapter({
      client: mock.client,
      now: () => new Date("2024-03-22T12:45:00Z"),
      channelCachePath: cachePath,
    });

    await adapter.start(async () => {});

    await mock.triggerNetwork("responseReceived", {
      requestId: "req-channels-search-1",
      type: "XHR",
      response: {
        url: "https://edgeapi.slack.com/cache/T0A93QQUMQW/channels/search?_x_app_name=client",
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json; charset=utf-8" },
      },
    });

    const raw = await readFile(
      path.join(tempRoot, "_cache", "slack", "channel-names-by-team", "T0A93QQUMQW.json"),
      "utf8"
    );
    const parsed = JSON.parse(raw) as {
      schema?: string;
      team_id?: string;
      channels?: Record<string, string>;
    };
    assert.equal(parsed.schema, "adjutant.slack.channel-cache.v1");
    assert.equal(parsed.team_id, "T0A93QQUMQW");
    assert.equal(parsed.channels?.C0AA05UDSX1, "検索チャンネルA");
    assert.equal(parsed.channels?.C0AA05UDSX2, "検索チャンネルB");
  });

  it("conversations.genericInfo応答でteam別チャンネル名キャッシュを更新する", async () => {
    const mock = createMockSlackClient();
    mock.responseBodies["req-conversations-generic-1"] = {
      base64Encoded: false,
      body: JSON.stringify({
        ok: true,
        results: [
          {
            id: "C0AA05UDH10",
            name: "alerts",
          },
          {
            id: "G0AA05UDH11",
            name_normalized: "private-alerts",
          },
        ],
      }),
    };
    const tempRoot = await mkdtemp(path.join(tmpdir(), "adjutant-channel-cache-"));
    const cachePath = path.join(tempRoot, "_cache", "slack", "channel-names-by-team.json");
    const adapter = new SlackAdapter({
      client: mock.client,
      now: () => new Date("2024-03-22T12:45:00Z"),
      channelCachePath: cachePath,
    });

    await adapter.start(async () => {});

    await mock.triggerNetwork("responseReceived", {
      requestId: "req-conversations-generic-1",
      type: "XHR",
      response: {
        url: "https://workspace.slack.com/api/conversations.genericInfo?slack_route=T0A93QQUMQW:T0A93QQUMQW",
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json; charset=utf-8" },
      },
    });

    const raw = await readFile(
      path.join(tempRoot, "_cache", "slack", "channel-names-by-team", "T0A93QQUMQW.json"),
      "utf8"
    );
    const parsed = JSON.parse(raw) as {
      schema?: string;
      team_id?: string;
      channels?: Record<string, string>;
    };
    assert.equal(parsed.schema, "adjutant.slack.channel-cache.v1");
    assert.equal(parsed.team_id, "T0A93QQUMQW");
    assert.equal(parsed.channels?.C0AA05UDH10, "alerts");
    assert.equal(parsed.channels?.G0AA05UDH11, "private-alerts");
  });

  it("search.modules.channels応答でteam別チャンネル名キャッシュを更新する", async () => {
    const mock = createMockSlackClient();
    mock.responseBodies["req-search-modules-channels-1"] = {
      base64Encoded: false,
      body: JSON.stringify({
        ok: true,
        module: "channels",
        items: [
          {
            id: "C0AA05UDH21",
            name: "mkr-cyg-stage",
          },
          {
            id: "C0AA05UDH22",
            name: "pinball_alert",
          },
        ],
      }),
    };
    const tempRoot = await mkdtemp(path.join(tmpdir(), "adjutant-channel-cache-"));
    const cachePath = path.join(tempRoot, "_cache", "slack", "channel-names-by-team.json");
    const adapter = new SlackAdapter({
      client: mock.client,
      now: () => new Date("2024-03-22T12:45:00Z"),
      channelCachePath: cachePath,
    });

    await adapter.start(async () => {});

    await mock.triggerNetwork("responseReceived", {
      requestId: "req-search-modules-channels-1",
      type: "XHR",
      response: {
        url: "https://workspace.slack.com/api/search.modules.channels?slack_route=T0A93QQUMQW",
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json; charset=utf-8" },
      },
    });

    const raw = await readFile(
      path.join(tempRoot, "_cache", "slack", "channel-names-by-team", "T0A93QQUMQW.json"),
      "utf8"
    );
    const parsed = JSON.parse(raw) as {
      schema?: string;
      team_id?: string;
      channels?: Record<string, string>;
    };
    assert.equal(parsed.schema, "adjutant.slack.channel-cache.v1");
    assert.equal(parsed.team_id, "T0A93QQUMQW");
    assert.equal(parsed.channels?.C0AA05UDH21, "mkr-cyg-stage");
    assert.equal(parsed.channels?.C0AA05UDH22, "pinball_alert");
  });

  it("client.userBoot応答でteam別チャンネル名キャッシュを更新する", async () => {
    const mock = createMockSlackClient();
    mock.responseBodies["req-client-userboot-1"] = {
      base64Encoded: false,
      body: JSON.stringify({
        ok: true,
        default_workspace: { id: "T0A93QQUMQW" },
        channels: [
          {
            id: "C0AA05UDUB1",
            name: "boot-default-a",
            context_team_id: "T0A93QQUMQW",
          },
          {
            id: "C0AA05UDUB2",
            name: "boot-default-b",
          },
          {
            id: "C0AA05UDUB3",
            name: "boot-cross-team",
            context_team_id: "T1111111111",
          },
        ],
      }),
    };
    const tempRoot = await mkdtemp(path.join(tmpdir(), "adjutant-channel-cache-"));
    const cachePath = path.join(tempRoot, "_cache", "slack", "channel-names-by-team.json");
    const adapter = new SlackAdapter({
      client: mock.client,
      now: () => new Date("2024-03-22T12:45:00Z"),
      channelCachePath: cachePath,
    });

    await adapter.start(async () => {});

    await mock.triggerNetwork("responseReceived", {
      requestId: "req-client-userboot-1",
      type: "XHR",
      response: {
        url: "https://workspace.slack.com/api/client.userBoot?_x_id=test",
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json; charset=utf-8" },
      },
    });

    const rawDefaultTeam = await readFile(
      path.join(tempRoot, "_cache", "slack", "channel-names-by-team", "T0A93QQUMQW.json"),
      "utf8"
    );
    const parsedDefaultTeam = JSON.parse(rawDefaultTeam) as {
      schema?: string;
      team_id?: string;
      channels?: Record<string, string>;
    };
    assert.equal(parsedDefaultTeam.schema, "adjutant.slack.channel-cache.v1");
    assert.equal(parsedDefaultTeam.team_id, "T0A93QQUMQW");
    assert.equal(parsedDefaultTeam.channels?.C0AA05UDUB1, "boot-default-a");
    assert.equal(parsedDefaultTeam.channels?.C0AA05UDUB2, "boot-default-b");

    const rawCrossTeam = await readFile(
      path.join(tempRoot, "_cache", "slack", "channel-names-by-team", "T1111111111.json"),
      "utf8"
    );
    const parsedCrossTeam = JSON.parse(rawCrossTeam) as {
      schema?: string;
      team_id?: string;
      channels?: Record<string, string>;
    };
    assert.equal(parsedCrossTeam.schema, "adjutant.slack.channel-cache.v1");
    assert.equal(parsedCrossTeam.team_id, "T1111111111");
    assert.equal(parsedCrossTeam.channels?.C0AA05UDUB3, "boot-cross-team");
  });

  it("users/list応答でteam別ユーザー名キャッシュを更新する", async () => {
    const mock = createMockSlackClient();
    mock.responseBodies["req-users-list-1"] = {
      base64Encoded: false,
      body: JSON.stringify({
        ok: true,
        results: [
          {
            id: "U0AA05G77UY",
            team_id: "T0A93QQUMQW",
            real_name: "Masahide YAMASAKI",
            profile: {
              display_name: "masahide",
              email: "masahide@example.com",
              first_name: "Masahide",
              last_name: "YAMASAKI",
              image_original: "https://example.com/u0aa05g77uy.png",
            },
          },
          {
            id: "U0A8ZEXKX27",
            team_id: "T0A93QQUMQW",
            real_name: "ジュンコ",
            profile: {
              display_name: "junco823",
              email: "junco@example.com",
              first_name: "ジュン",
              last_name: "コ",
              image_original: "https://example.com/u0a8zexkx27.png",
            },
          },
        ],
      }),
    };
    const tempRoot = await mkdtemp(path.join(tmpdir(), "adjutant-user-cache-"));
    const cachePath = path.join(tempRoot, "_cache", "slack", "user-names-by-team.json");
    const adapter = new SlackAdapter({
      client: mock.client,
      now: () => new Date("2024-03-22T12:45:00Z"),
      userCachePath: cachePath,
    });

    await adapter.start(async () => {});

    await mock.triggerNetwork("responseReceived", {
      requestId: "req-users-list-1",
      type: "XHR",
      response: {
        url: "https://edgeapi.slack.com/cache/T0A93QQUMQW/users/list?_x_app_name=client",
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json; charset=utf-8" },
      },
    });

    const raw = await readFile(
      path.join(tempRoot, "_cache", "slack", "user-names-by-team", "T0A93QQUMQW.json"),
      "utf8"
    );
    const parsed = JSON.parse(raw) as {
      schema?: string;
      team_id?: string;
      users?: Record<
        string,
        {
          real_name?: string;
          profile?: {
            display_name?: string;
            email?: string;
            first_name?: string;
            last_name?: string;
            image_original?: string;
          };
        }
      >;
    };
    assert.equal(parsed.schema, "adjutant.slack.user-cache.v2");
    assert.equal(parsed.team_id, "T0A93QQUMQW");
    assert.equal(parsed.users?.U0AA05G77UY?.real_name, "Masahide YAMASAKI");
    assert.equal(parsed.users?.U0AA05G77UY?.profile?.display_name, "masahide");
    assert.equal(parsed.users?.U0AA05G77UY?.profile?.email, "masahide@example.com");
    assert.equal(parsed.users?.U0AA05G77UY?.profile?.first_name, "Masahide");
    assert.equal(parsed.users?.U0AA05G77UY?.profile?.last_name, "YAMASAKI");
    assert.equal(
      parsed.users?.U0AA05G77UY?.profile?.image_original,
      "https://example.com/u0aa05g77uy.png"
    );
    assert.equal(parsed.users?.U0A8ZEXKX27?.real_name, "ジュンコ");
    assert.equal(parsed.users?.U0A8ZEXKX27?.profile?.display_name, "junco823");
    assert.equal(parsed.users?.U0A8ZEXKX27?.profile?.email, "junco@example.com");
    assert.equal(parsed.users?.U0A8ZEXKX27?.profile?.first_name, "ジュン");
    assert.equal(parsed.users?.U0A8ZEXKX27?.profile?.last_name, "コ");
    assert.equal(
      parsed.users?.U0A8ZEXKX27?.profile?.image_original,
      "https://example.com/u0a8zexkx27.png"
    );
  });
});
