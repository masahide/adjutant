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
          { id: "U1", team_id: "T1", name: "alice" },
          { id: "U2", profile: { team: "T1", display_name: "bob" } },
        ],
      },
      { pathSegments: ["cache", "T1", "users", "list"] }
    );

    assert.deepEqual(projected, [
      { teamId: "T1", userId: "U1", userName: "alice" },
      { teamId: "T1", userId: "U2", userName: "bob" },
    ]);
  });

  it("users/listでteam_idが無い場合はURL pathのteamを使う", () => {
    const projector = new SlackResponseProjector();
    const projected = projector.projectUsersList(
      {
        ok: true,
        results: [{ id: "U10", profile: { display_name: "neo" } }],
      },
      { pathSegments: ["cache", "T10", "users", "list"] }
    );

    assert.deepEqual(projected, [{ teamId: "T10", userId: "U10", userName: "neo" }]);
  });

  it("不正レスポンスでは空結果を返す", () => {
    const projector = new SlackResponseProjector();
    assert.equal(projector.projectConversationsView({ ok: false }), null);
    assert.deepEqual(projector.projectUsersList({ ok: false }, null), []);
  });
});
