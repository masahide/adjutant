import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SlackNameCacheRepository } from "../../../src/collector-slack/slack-name-cache-repository.js";

function createRepoRoot(): string {
  return mkdtempSync(join(tmpdir(), "adjutant-slack-cache-"));
}

test("persist/load で channel/user cache を復元できる", () => {
  const root = createRepoRoot();
  const repoA = new SlackNameCacheRepository({
    baseDir: root,
    now: () => new Date("2026-03-03T10:00:00.000Z"),
  });

  repoA.setChannelName("T001", "C001", "general");
  repoA.setUserProfile("T001", "U001", { display_name: "taro", real_name: "Taro Yamada" });
  repoA.persist();

  const repoB = new SlackNameCacheRepository({ baseDir: root });
  repoB.load();

  assert.equal(repoB.resolveChannelName("C001", "T001"), "general");
  assert.equal(repoB.resolveUserName("U001", "T001"), "taro");
});

test("load は壊れた JSON ファイルを無視して継続する", () => {
  const root = createRepoRoot();
  const channelDir = join(root, "channel-names-by-team");
  const userDir = join(root, "user-names-by-team");
  mkdirSync(channelDir, { recursive: true });
  mkdirSync(userDir, { recursive: true });
  writeFileSync(join(channelDir, "T001.json"), "{ invalid", "utf8");
  writeFileSync(join(userDir, "T001.json"), "{ invalid", "utf8");

  const repo = new SlackNameCacheRepository({ baseDir: root });
  repo.load();

  assert.equal(repo.resolveChannelName("C001", "T001"), undefined);
  assert.equal(repo.resolveUserName("U001", "T001"), undefined);
});

test("teamId hint なしでも name を解決できる", () => {
  const root = createRepoRoot();
  const repo = new SlackNameCacheRepository({ baseDir: root });
  repo.setChannelName("T001", "C001", "general");
  repo.setUserProfile("T001", "U001", { real_name: "Taro Yamada" });
  repo.persist();
  repo.load();

  assert.equal(repo.resolveChannelName("C001"), "general");
  assert.equal(repo.resolveUserName("U001"), "Taro Yamada");
});
