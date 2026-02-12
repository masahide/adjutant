import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SlackResponseProjector } from "../../src/slack/responseProjector.js";

describe("SlackResponseProjector", () => {
  it("conversations.viewレスポンスを投影できる", () => {
    const projector = new SlackResponseProjector();
    const projected = projector.projectConversationsView({
      ok: true,
      channel: {
        id: "C123",
        name: "general",
        context_team_id: "T123",
      },
    });

    assert.deepEqual(projected, {
      teamId: "T123",
      channelId: "C123",
      channelName: "general",
    });
  });

  it("users/listレスポンスを投影できる", () => {
    const projector = new SlackResponseProjector();
    const projected = projector.projectUsersList(
      {
        ok: true,
        results: [
          {
            id: "U1",
            team_id: "T1",
            real_name: "Alice Example",
            profile: {
              display_name: "alice",
              email: "alice@example.com",
              first_name: "Alice",
              last_name: "Example",
              image_original: "https://example.com/u1.png",
            },
          },
          {
            id: "U2",
            profile: {
              team: "T1",
              display_name: "bob",
            },
          },
        ],
      },
      { pathSegments: ["cache", "T1", "users", "list"] }
    );

    assert.deepEqual(projected, [
      {
        teamId: "T1",
        userId: "U1",
        user: {
          real_name: "Alice Example",
          profile: {
            display_name: "alice",
            email: "alice@example.com",
            first_name: "Alice",
            last_name: "Example",
            image_original: "https://example.com/u1.png",
          },
        },
      },
      {
        teamId: "T1",
        userId: "U2",
        user: {
          profile: {
            display_name: "bob",
          },
        },
      },
    ]);
  });

  it("users/listでteam_idが無い場合はURL pathのteamを使う", () => {
    const projector = new SlackResponseProjector();
    const projected = projector.projectUsersList(
      {
        ok: true,
        results: [{ id: "U10", profile: { display_name: "neo", email: "neo@example.com" } }],
      },
      { pathSegments: ["cache", "T10", "users", "list"] }
    );

    assert.deepEqual(projected, [
      {
        teamId: "T10",
        userId: "U10",
        user: {
          profile: {
            display_name: "neo",
            email: "neo@example.com",
          },
        },
      },
    ]);
  });

  it("channels/infoレスポンスを投影できる", () => {
    const projector = new SlackResponseProjector();
    const projected = projector.projectChannelsInfo(
      {
        ok: true,
        channels: [
          { id: "C01ABCDE23", name: "general" },
          { id: "D01ABCDE24", name: "dm-room", team_id: "T20" },
        ],
      },
      { pathSegments: ["cache", "T10", "channels", "info"] }
    );

    assert.deepEqual(projected, [
      {
        teamId: "T10",
        channelId: "C01ABCDE23",
        channelName: "general",
      },
      {
        teamId: "T20",
        channelId: "D01ABCDE24",
        channelName: "dm-room",
      },
    ]);
  });

  it("channels/searchレスポンスを投影できる", () => {
    const projector = new SlackResponseProjector();
    const projected = projector.projectChannelsSearch(
      {
        ok: true,
        results: [
          { id: "C01ABCDE97", name: "search-channel" },
          { id: "G01ABCDE96", name_normalized: "search-private-channel" },
        ],
      },
      { pathSegments: ["cache", "T31", "channels", "search"] }
    );

    assert.deepEqual(projected, [
      {
        teamId: "T31",
        channelId: "C01ABCDE97",
        channelName: "search-channel",
      },
      {
        teamId: "T31",
        channelId: "G01ABCDE96",
        channelName: "search-private-channel",
      },
    ]);
  });

  it("conversations.genericInfoレスポンスを投影できる", () => {
    const projector = new SlackResponseProjector();
    const projected = projector.projectConversationsGenericInfo(
      {
        ok: true,
        results: [
          { id: "C01ABCDE99", name: "alerts" },
          { id: "G01ABCDE98", name_normalized: "private-alerts" },
        ],
      },
      { query: { slack_route: "T30:T30" } }
    );

    assert.deepEqual(projected, [
      {
        teamId: "T30",
        channelId: "C01ABCDE99",
        channelName: "alerts",
      },
      {
        teamId: "T30",
        channelId: "G01ABCDE98",
        channelName: "private-alerts",
      },
    ]);
  });

  it("search.modules.channelsレスポンスを投影できる", () => {
    const projector = new SlackResponseProjector();
    const projected = projector.projectSearchModulesChannels(
      {
        ok: true,
        module: "channels",
        items: [
          { id: "C01ABCDE55", name: "ops-alerts" },
          { id: "G01ABCDE56", name: "private-ops-alerts" },
        ],
      },
      { query: { slack_route: "T50ABCDE1" } }
    );

    assert.deepEqual(projected, [
      {
        teamId: "T50ABCDE1",
        channelId: "C01ABCDE55",
        channelName: "ops-alerts",
      },
      {
        teamId: "T50ABCDE1",
        channelId: "G01ABCDE56",
        channelName: "private-ops-alerts",
      },
    ]);
  });

  it("client.userBootレスポンスを投影できる", () => {
    const projector = new SlackResponseProjector();
    const projected = projector.projectClientUserBoot({
      ok: true,
      default_workspace: { id: "T70" },
      channels: [
        { id: "C01ABCDE45", name: "team-default" },
        { id: "C01ABCDE46", name: "team-context", context_team_id: "T71" },
        { id: "C01ABCDE46", name: "team-context-duplicate", context_team_id: "T71" },
      ],
    });

    assert.deepEqual(projected, [
      {
        teamId: "T70",
        channelId: "C01ABCDE45",
        channelName: "team-default",
      },
      {
        teamId: "T71",
        channelId: "C01ABCDE46",
        channelName: "team-context",
      },
    ]);
  });

  it("不正レスポンスでは空結果を返す", () => {
    const projector = new SlackResponseProjector();
    assert.equal(projector.projectConversationsView({ ok: false }), null);
    assert.deepEqual(projector.projectUsersList({ ok: false }, null), []);
    assert.deepEqual(projector.projectChannelsInfo({ ok: false }, null), []);
    assert.deepEqual(projector.projectChannelsSearch({ ok: false }, null), []);
    assert.deepEqual(projector.projectConversationsGenericInfo({ ok: false }, null), []);
    assert.deepEqual(projector.projectSearchModulesChannels({ ok: false }, null), []);
    assert.deepEqual(projector.projectClientUserBoot({ ok: false }), []);
  });
});
