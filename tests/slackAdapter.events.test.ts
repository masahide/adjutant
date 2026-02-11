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
          schema: "adjutant.slack.user-cache.v1",
          team_id: "T1",
          users: { U333: "alice" },
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
        headers: { "content-type": "application/json" },
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
          };
        }
      | undefined;
    assert.ok(rawFetch, "raw_fetch event should be emitted");
    assert.equal(rawFetch.payload?.method, "POST");
    assert.equal(rawFetch.payload?.url, "https://hooks.slack.com/services/T00/B00/XXX");
    assert.equal(rawFetch.payload?.urlInfo?.host, "hooks.slack.com");
    assert.equal(rawFetch.payload?.urlInfo?.pathname, "/services/T00/B00/XXX");
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
            name: "masahide.y",
            real_name: "Masahide YAMASAKI",
          },
          {
            id: "U0A8ZEXKX27",
            team_id: "T0A93QQUMQW",
            name: "junco823",
            real_name: "ジュンコ",
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
      users?: Record<string, string>;
    };
    assert.equal(parsed.schema, "adjutant.slack.user-cache.v1");
    assert.equal(parsed.team_id, "T0A93QQUMQW");
    assert.equal(parsed.users?.U0AA05G77UY, "masahide.y");
    assert.equal(parsed.users?.U0A8ZEXKX27, "junco823");
  });
});
