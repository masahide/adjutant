import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SlackNameCacheRepository } from "../../../src/collector-slack/slack-name-cache-repository.js";

test("複数 team の channel/user cache を保存して再読込できる", () => {
  const root = mkdtempSync(join(tmpdir(), "adjutant-slack-cache-integ-"));
  const repo = new SlackNameCacheRepository({
    baseDir: root,
    now: () => new Date("2026-03-03T12:00:00.000Z"),
  });

  repo.setChannelName("T001", "C001", "general");
  repo.setUserProfile("T001", "U001", { display_name: "taro" });
  repo.setChannelName("T002", "C002", "dev");
  repo.setUserProfile("T002", "U002", { real_name: "Hanako Sato" });
  repo.persist();

  const loaded = new SlackNameCacheRepository({ baseDir: root });
  loaded.load();

  assert.equal(loaded.resolveChannelName("C001", "T001"), "general");
  assert.equal(loaded.resolveUserName("U001", "T001"), "taro");
  assert.equal(loaded.resolveChannelName("C002", "T002"), "dev");
  assert.equal(loaded.resolveUserName("U002", "T002"), "Hanako Sato");
});
