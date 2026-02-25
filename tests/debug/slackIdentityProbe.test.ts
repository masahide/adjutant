import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { SlackIdentityProbe } from "../../src/debug/slackIdentityProbe.js";
import { SlackNameCacheRepository } from "../../src/slack/nameCacheRepository.js";

const createCacheRepository = async (params: { userId?: string; channelId?: string } = {}) => {
  const repository = new SlackNameCacheRepository();
  if (params.channelId) {
    await repository.updateChannel("T1", params.channelId, "cached-channel");
  }
  if (params.userId) {
    await repository.updateUsers([
      {
        teamId: "T1",
        userId: params.userId,
        user: { profile: { display_name: "cached-user" } },
      },
    ]);
  }
  return repository;
};

describe("SlackIdentityProbe", () => {
  it("token/user/channel を抽出して users.info と conversations.info を呼び出す", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const cacheRepository = await createCacheRepository({ userId: "U111", channelId: "C111" });
    const probe = new SlackIdentityProbe({
      cacheRepository,
      fetchImpl: (async (url, init) => {
        const requestBody = typeof init?.body === "string" ? init.body : "";
        calls.push({ url: String(url), body: requestBody });

        if (String(url).endsWith("/api/users.info")) {
          return new Response(
            JSON.stringify({
              ok: true,
              user: { name: "alice", profile: { display_name: "alice-display" } },
            }),
            { status: 200 }
          );
        }
        if (String(url).endsWith("/api/conversations.info")) {
          return new Response(
            JSON.stringify({
              ok: true,
              channel: { id: "C111", name: "general" },
            }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ ok: false, error: "unknown_endpoint" }), {
          status: 404,
        });
      }) as typeof fetch,
    });

    const result = await probe.resolve({
      requestId: "req-1",
      method: "POST",
      url: "https://example.slack.com/api/chat.postMessage",
      contentType: "text/plain; charset=utf-8",
      body: JSON.stringify({
        token: "xoxc-sample-token",
        user_id: "U111",
        channel_id: "C111",
      }),
    });

    assert.equal(result.ok, true);
    assert.equal(result.usersInfo.ok, true);
    assert.equal(result.usersInfo.name, "alice-display");
    assert.equal(result.conversationsInfo.ok, true);
    assert.equal(result.conversationsInfo.name, "general");
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.url.endsWith("/api/users.info"), true);
    assert.equal(calls[1]?.url.endsWith("/api/conversations.info"), true);
    assert.match(calls[0]?.body ?? "", /token=xoxc-sample-token/);
    assert.equal(result.apiCalls.length, 2);
    assert.equal(result.apiCalls[0]?.request?.params?.token, "xoxc...oken");
  });

  it("token が無い場合は API 呼び出しを行わず警告を返す", async () => {
    let called = 0;
    const probe = new SlackIdentityProbe({
      fetchImpl: (async () => {
        called += 1;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }) as typeof fetch,
    });

    const result = await probe.resolve({
      url: "https://example.slack.com/api/chat.postMessage",
      contentType: "application/json",
      body: JSON.stringify({ user: "U111", channel: "C111" }),
    });

    assert.equal(result.ok, false);
    assert.equal(called, 0);
    assert.equal(result.usersInfo.attempted, false);
    assert.equal(result.conversationsInfo.attempted, false);
    assert.equal(
      result.warnings.some((message) => message.includes("token")),
      true
    );
  });

  it("conversations.* API のとき users.info を呼ばない", async () => {
    const calls: string[] = [];
    const cacheRepository = await createCacheRepository({ channelId: "C111" });
    const probe = new SlackIdentityProbe({
      cacheRepository,
      fetchImpl: (async (url) => {
        calls.push(String(url));
        return new Response(
          JSON.stringify({ ok: true, channel: { id: "C111", name: "general" } }),
          {
            status: 200,
          }
        );
      }) as typeof fetch,
    });

    const result = await probe.resolve({
      url: "https://example.slack.com/api/conversations.mark",
      contentType: "application/json",
      body: JSON.stringify({
        token: "xoxc-token",
        channel: "C111",
        user: "U111",
      }),
    });

    assert.equal(result.usersInfo.attempted, false);
    assert.equal(result.conversationsInfo.attempted, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.endsWith("/api/conversations.info"), true);
  });

  it("users.* API のとき conversations.info を呼ばない", async () => {
    const calls: string[] = [];
    const cacheRepository = await createCacheRepository({ userId: "U111" });
    const probe = new SlackIdentityProbe({
      cacheRepository,
      fetchImpl: (async (url) => {
        calls.push(String(url));
        return new Response(
          JSON.stringify({ ok: true, user: { profile: { display_name: "alice" } } }),
          {
            status: 200,
          }
        );
      }) as typeof fetch,
    });

    const result = await probe.resolve({
      url: "https://example.slack.com/api/users.profile.set",
      contentType: "application/json",
      body: JSON.stringify({
        token: "xoxc-token",
        user: "U111",
        channel: "C111",
      }),
    });

    assert.equal(result.usersInfo.attempted, true);
    assert.equal(result.conversationsInfo.attempted, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.endsWith("/api/users.info"), true);
  });

  it("IDが無い場合はキャッシュから補完して問い合わせる", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "adjutant-probe-cache-"));
    const channelCachePath = path.join(root, "_cache", "slack", "channel-names-by-team.json");
    const userCachePath = path.join(root, "_cache", "slack", "user-names-by-team.json");
    await mkdir(path.join(root, "_cache", "slack", "channel-names-by-team"), { recursive: true });
    await mkdir(path.join(root, "_cache", "slack", "user-names-by-team"), { recursive: true });
    await writeFile(
      path.join(root, "_cache", "slack", "channel-names-by-team", "T1.json"),
      JSON.stringify({
        schema: "adjutant.slack.channel-cache.v1",
        team_id: "T1",
        channels: {
          C_FALLBACK: "fallback-channel",
        },
      })
    );
    await writeFile(
      path.join(root, "_cache", "slack", "user-names-by-team", "T1.json"),
      JSON.stringify({
        schema: "adjutant.slack.user-cache.v2",
        team_id: "T1",
        users: {
          U_FALLBACK: {
            profile: { display_name: "fallback-user" },
          },
        },
      })
    );

    const calls: Array<{ url: string; body: string }> = [];
    const probe = new SlackIdentityProbe({
      channelCachePath,
      userCachePath,
      fetchImpl: (async (url, init) => {
        const requestBody = typeof init?.body === "string" ? init.body : "";
        calls.push({ url: String(url), body: requestBody });
        return new Response(
          JSON.stringify({
            ok: true,
            channel: { id: "C_FALLBACK", name: "fallback-channel" },
          }),
          { status: 200 }
        );
      }) as typeof fetch,
    });

    const result = await probe.resolve({
      url: "https://example.slack.com/api/conversations.mark?slack_route=T1:T1",
      contentType: "application/json",
      body: JSON.stringify({
        token: "xoxc-sample-token",
      }),
    });

    assert.equal(result.channelId, "C_FALLBACK");
    assert.equal(
      result.warnings.some((message) => message.includes("キャッシュ参照")),
      true
    );
    assert.equal(calls.length, 1);
    assert.match(calls[0]?.body ?? "", /channel=C_FALLBACK/);
  });

  it("edgeapi cache users/info を users 系として判定する", async () => {
    const cacheRepository = await createCacheRepository({ userId: "U_CACHED" });
    const calls: Array<{ url: string; body: string }> = [];
    const requestUrl = "https://edgeapi.slack.com/cache/T1/users/info?_x_app_name=client";
    const probe = new SlackIdentityProbe({
      cacheRepository,
      fetchImpl: (async (url, init) => {
        calls.push({
          url: String(url),
          body: typeof init?.body === "string" ? init.body : "",
        });
        return new Response(
          JSON.stringify({
            ok: true,
            users: {
              U_CACHED: {
                profile: { display_name: "cached-user" },
              },
            },
          }),
          { status: 200 }
        );
      }) as typeof fetch,
    });

    const result = await probe.resolve({
      url: requestUrl,
      contentType: "text/plain;charset=UTF-8",
      body: JSON.stringify({ token: "xoxc-token" }),
    });

    assert.equal(result.usersInfo.attempted, true);
    assert.equal(result.usersInfo.ok, true);
    assert.equal(result.usersInfo.name, "cached-user");
    assert.equal(result.conversationsInfo.attempted, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, requestUrl);
    assert.match(calls[0]?.body ?? "", /\"updated_ids\"/);
    assert.match(calls[0]?.body ?? "", /\"U_CACHED\"/);
  });
});
