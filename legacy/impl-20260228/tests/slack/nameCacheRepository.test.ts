import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { SlackNameCacheRepository } from "../../src/slack/nameCacheRepository.js";

describe("SlackNameCacheRepository", () => {
  it("team別キャッシュを読み込み名前解決できる", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "adjutant-name-cache-"));
    const channelCachePath = path.join(root, "_cache", "slack", "channel-names-by-team.json");
    const userCachePath = path.join(root, "_cache", "slack", "user-names-by-team.json");
    await mkdir(path.join(root, "_cache", "slack", "channel-names-by-team"), { recursive: true });
    await mkdir(path.join(root, "_cache", "slack", "user-names-by-team"), { recursive: true });

    await writeFile(
      path.join(root, "_cache", "slack", "channel-names-by-team", "T1.json"),
      `${JSON.stringify({ channels: { C1: "general" } })}\n`,
      "utf8"
    );
    await writeFile(
      path.join(root, "_cache", "slack", "user-names-by-team", "T1.json"),
      `${JSON.stringify({
        schema: "adjutant.slack.user-cache.v2",
        team_id: "T1",
        users: { U1: { profile: { display_name: "alice" } } },
      })}\n`,
      "utf8"
    );

    const repo = new SlackNameCacheRepository({ channelCachePath, userCachePath });
    await repo.load();

    assert.equal(repo.resolveTeam(undefined, "C1"), "T1");
    assert.equal(repo.resolveChannelName("C1", "T1"), "general");
    assert.equal(repo.resolveUserName("U1", "T1", "C1"), "alice");
  });

  it("updateChannel/updateUsersで永続化しchanged件数を返す", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "adjutant-name-cache-"));
    const channelCachePath = path.join(root, "_cache", "slack", "channel-names-by-team.json");
    await mkdir(path.join(root, "_cache", "slack", "channel-names-by-team"), { recursive: true });
    const userCachePath = path.join(root, "_cache", "slack", "user-names-by-team.json");

    const repo = new SlackNameCacheRepository({
      channelCachePath,
      userCachePath,
      now: () => new Date("2026-02-11T10:00:00Z"),
    });

    const channelChanged = await repo.updateChannel("T2", "C2", "random");
    assert.ok(channelChanged);
    assert.equal(channelChanged?.teamId, "T2");
    assert.equal(channelChanged?.changed, 1);

    const userChanged = await repo.updateUsers([
      {
        teamId: "T2",
        userId: "U2",
        user: {
          real_name: "Bob Example",
          profile: {
            display_name: "bob",
            email: "bob@example.com",
            first_name: "Bob",
            last_name: "Example",
            image_original: "https://example.com/u2.png",
          },
        },
      },
      {
        teamId: "T2",
        userId: "U3",
        user: {
          real_name: "Carol Example",
          profile: {
            display_name: "carol",
          },
        },
      },
    ]);
    assert.equal(userChanged.length, 1);
    assert.equal(userChanged[0]?.teamId, "T2");
    assert.equal(userChanged[0]?.changed, 2);

    const channelFile = JSON.parse(
      await readFile(path.join(root, "_cache", "slack", "channel-names-by-team", "T2.json"), "utf8")
    ) as { channels: Record<string, string> };
    assert.equal(channelFile.channels.C2, "random");

    const userFile = JSON.parse(
      await readFile(path.join(root, "_cache", "slack", "user-names-by-team", "T2.json"), "utf8")
    ) as {
      schema?: string;
      users: Record<
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
    assert.equal(userFile.schema, "adjutant.slack.user-cache.v2");
    assert.equal(userFile.users.U2?.real_name, "Bob Example");
    assert.equal(userFile.users.U2?.profile?.display_name, "bob");
    assert.equal(userFile.users.U2?.profile?.email, "bob@example.com");
    assert.equal(userFile.users.U2?.profile?.first_name, "Bob");
    assert.equal(userFile.users.U2?.profile?.last_name, "Example");
    assert.equal(userFile.users.U2?.profile?.image_original, "https://example.com/u2.png");
    assert.equal(userFile.users.U3?.real_name, "Carol Example");
    assert.equal(userFile.users.U3?.profile?.display_name, "carol");
  });

  it("壊れたキャッシュファイルでもloadは失敗しない", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "adjutant-name-cache-"));
    const channelCachePath = path.join(root, "_cache", "slack", "channel-names-by-team.json");
    await mkdir(path.join(root, "_cache", "slack", "channel-names-by-team"), { recursive: true });

    await writeFile(
      path.join(root, "_cache", "slack", "channel-names-by-team", "T1.json"),
      "{broken-json",
      "utf8"
    );

    const repo = new SlackNameCacheRepository({ channelCachePath });
    await repo.load();

    assert.equal(repo.resolveChannelName("C1", "T1"), undefined);
  });

  it("同一IDが複数teamに存在する場合はteam hintなし解決を曖昧扱いにする", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "adjutant-name-cache-"));
    const channelCachePath = path.join(root, "_cache", "slack", "channel-names-by-team.json");
    await mkdir(path.join(root, "_cache", "slack", "channel-names-by-team"), { recursive: true });

    await writeFile(
      path.join(root, "_cache", "slack", "channel-names-by-team", "T1.json"),
      `${JSON.stringify({ channels: { C1: "general" } })}\n`,
      "utf8"
    );
    await writeFile(
      path.join(root, "_cache", "slack", "channel-names-by-team", "T2.json"),
      `${JSON.stringify({ channels: { C1: "random" } })}\n`,
      "utf8"
    );

    const repo = new SlackNameCacheRepository({ channelCachePath });
    await repo.load();

    assert.equal(repo.resolveChannelName("C1", undefined), undefined);
    assert.equal(repo.resolveChannelName("C1", "T1"), "general");
    assert.equal(repo.resolveChannelName("C1", "T2"), "random");
  });
});
