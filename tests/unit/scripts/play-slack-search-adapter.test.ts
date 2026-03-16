import assert from "node:assert/strict";
import test from "node:test";

import {
  executeAdapterRequest,
  extractThreadTsFromUrl,
  resolveThreadPermalinkFromMessage,
} from "../../../scripts/play-slack-search-adapter.js";

test("extractThreadTsFromUrl は thread permalink から thread_ts を抽出する", () => {
  assert.equal(
    extractThreadTsFromUrl(
      "https://workspace.slack.com/archives/C1/p1773481739636659?thread_ts=1773481700.000001&cid=C1"
    ),
    "1773481700.000001"
  );
});

test("resolveThreadPermalinkFromMessage は message pageUrl から親 thread permalink を解決する", () => {
  const permalink = resolveThreadPermalinkFromMessage(
    {
      mode: "message",
      channelId: "C1",
      messageTs: "1773481739.636659",
      workspaceUrl: "https://workspace.slack.com",
    },
    "https://workspace.slack.com",
    {
      mode: "permalink",
      items: [
        {
          messageUrl:
            "https://workspace.slack.com/archives/C1/p1773481739636659?thread_ts=1773481700.000001&cid=C1",
          sender: "bot",
          slackTs: "1773481739.636659",
          text: "reply",
        },
      ],
      pageTitle: "message",
      pageUrl:
        "https://workspace.slack.com/archives/C1/p1773481739636659?thread_ts=1773481700.000001&cid=C1",
    }
  );

  assert.equal(
    permalink,
    "https://workspace.slack.com/archives/C1/p1773481700000001?thread_ts=1773481700.000001&cid=C1"
  );
});

test("executeAdapterRequest は mode=message で message -> thread へ昇格して再fetchする", () => {
  const calls: string[] = [];
  const result = executeAdapterRequest(
    {
      mode: "message",
      channelId: "C1",
      messageTs: "1773481739.636659",
      workspaceUrl: "https://workspace.slack.com",
    },
    {
      workspaceUrl: "https://workspace.slack.com",
      session: "auto",
    },
    {
      executeSlackCommand: (() => {
        throw new Error("search path should not be used");
      }) as never,
      runPermalinkPayload: ((permalink: string) => {
        calls.push(permalink);
        if (calls.length === 1) {
          return {
            mode: "permalink",
            items: [
              {
                messageUrl:
                  "https://workspace.slack.com/archives/C1/p1773481739636659?thread_ts=1773481700.000001&cid=C1",
                sender: "bot",
                slackTs: "1773481739.636659",
                text: "reply",
              },
            ],
            pageTitle: "message",
            pageUrl:
              "https://workspace.slack.com/archives/C1/p1773481739636659?thread_ts=1773481700.000001&cid=C1",
          };
        }
        return {
          mode: "permalink",
          items: [
            {
              messageUrl:
                "https://workspace.slack.com/archives/C1/p1773481700000001?thread_ts=1773481700.000001&cid=C1",
              sender: "bot",
              slackTs: "1773481700.000001",
              text: "thread root",
            },
          ],
          pageTitle: "thread",
          pageUrl:
            "https://workspace.slack.com/archives/C1/p1773481700000001?thread_ts=1773481700.000001&cid=C1",
        };
      }) as never,
    }
  );

  assert.deepEqual(calls, [
    "https://workspace.slack.com/archives/C1/p1773481739636659",
    "https://workspace.slack.com/archives/C1/p1773481700000001?thread_ts=1773481700.000001&cid=C1",
  ]);
  assert.equal(result.mode, "message");
  assert.equal(result.items[0]?.text, "thread root");
  assert.equal(result.warnings, undefined);
});

test("executeAdapterRequest は mode=login で instructions を返す", () => {
  const result = executeAdapterRequest(
    {
      mode: "login",
      workspaceUrl: "https://workspace.slack.com",
    },
    {
      workspaceUrl: "https://workspace.slack.com",
      session: "auto",
    }
  );

  assert.equal(result.mode, "login");
  assert.equal(result.items.length, 0);
  assert.match(result.instructions ?? "", /complete login/i);
  assert.equal(result.sourceUrl, "https://workspace.slack.com");
});

test("executeAdapterRequest は mode=list-users で user list payload を正規化する", () => {
  const result = executeAdapterRequest(
    {
      mode: "list-users",
      workspaceUrl: "https://workspace.slack.com",
      hydrate: true,
      limit: 10,
    },
    {
      workspaceUrl: "https://workspace.slack.com",
      session: "auto",
    },
    {
      executeSlackCommand: (() => ({
        mode: "list-users",
        users: [
          {
            id: "U123",
            name: "alice",
            realName: "Alice",
            isBot: false,
          },
        ],
        listUrl: "https://workspace.slack.com/client/T1",
        source: "reduxPersistence.users",
        stateKey: "users",
        totalUserCount: 1,
      })) as never,
      runPermalinkPayload: (() => {
        throw new Error("permalink path should not be used");
      }) as never,
    }
  );

  assert.deepEqual(result, {
    mode: "list-users",
    users: [
      {
        id: "U123",
        name: "alice",
        realName: "Alice",
        isBot: false,
      },
    ],
    sourceUrl: "https://workspace.slack.com/client/T1",
    source: "reduxPersistence.users",
    stateKey: "users",
    totalUserCount: 1,
  });
});

test("executeAdapterRequest は mode=resolve-channel-id で channel 解決 payload を正規化する", () => {
  const result = executeAdapterRequest(
    {
      mode: "resolve-channel-id",
      workspaceUrl: "https://workspace.slack.com",
      channelIds: ["C123"],
    },
    {
      workspaceUrl: "https://workspace.slack.com",
      session: "auto",
    },
    {
      executeSlackCommand: (() => ({
        mode: "resolve-channels",
        channels: [
          {
            channelId: "C123",
            channelName: "general",
            resolved: true,
            source: "search.suggestion",
            stateKey: "channels",
          },
        ],
        listUrl: "https://workspace.slack.com/client/T1",
      })) as never,
      runPermalinkPayload: (() => {
        throw new Error("permalink path should not be used");
      }) as never,
    }
  );

  assert.deepEqual(result, {
    mode: "resolve-channel-id",
    channels: [
      {
        channelId: "C123",
        channelName: "general",
        resolved: true,
        source: "search.suggestion",
        stateKey: "channels",
      },
    ],
    sourceUrl: "https://workspace.slack.com/client/T1",
  });
});
