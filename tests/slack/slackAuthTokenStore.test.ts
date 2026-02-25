import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import {
  resolveSlackAuthAccountStorePath,
  resolveSlackAuthPendingStorePath,
  SlackAuthTokenStore,
} from "../../src/slack/slackAuthTokenStore.js";

describe("SlackAuthTokenStore", () => {
  it("pending/account ストアを保存して再読込できる", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "adjutant-auth-token-store-"));
    const store = new SlackAuthTokenStore({
      dataDir,
      now: () => new Date("2026-02-25T00:00:00.000Z"),
    });

    try {
      await store.writePending([
        {
          workspaceKey: "team-subdomain",
          aliases: ["team-subdomain"],
          tokens: {
            xoxc: {
              value: "xoxc-111",
              firstSeenAt: 1,
              lastSeenAt: 2,
              hits: 3,
              sourceStage: "requestWillBeSent",
            },
            xoxd: {
              value: "xoxd-222",
              firstSeenAt: 1,
              lastSeenAt: 2,
              hits: 3,
              sourceStage: "requestWillBeSentExtraInfo",
            },
          },
          authTest: {
            status: "pending",
          },
        },
      ]);

      await store.writeAccount("E123456", [
        {
          workspaceKey: "T123456",
          aliases: ["T123456", "workspace"],
          tokens: {
            xoxc: {
              value: "xoxc-acc",
              firstSeenAt: 10,
              lastSeenAt: 11,
              hits: 1,
              sourceStage: "requestWillBeSent",
            },
            xoxd: {
              value: "xoxd-acc",
              firstSeenAt: 10,
              lastSeenAt: 11,
              hits: 1,
              sourceStage: "requestWillBeSentExtraInfo",
            },
          },
          authTest: {
            status: "ok",
            teamId: "T123456",
            enterpriseId: "E123456",
          },
        },
      ]);

      const pendingPath = resolveSlackAuthPendingStorePath(dataDir);
      const pendingRaw = await readFile(pendingPath, "utf8");
      assert.equal(pendingRaw.includes("adjutant.slack.auth-token-store.v1"), true);

      const accountPath = resolveSlackAuthAccountStorePath(dataDir, "E123456");
      const accountRaw = await readFile(accountPath, "utf8");
      assert.equal(accountRaw.includes('"workspaceKey": "T123456"'), true);

      const loaded = store.loadAllSync();
      assert.equal(loaded.pending.length, 1);
      assert.equal(loaded.pending[0]?.workspaceKey, "team-subdomain");
      assert.equal(loaded.byAccount.get("E123456")?.length, 1);
      assert.equal(loaded.byAccount.get("E123456")?.[0]?.authTest?.enterpriseId, "E123456");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("壊れた JSON は読み飛ばす", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "adjutant-auth-token-store-corrupt-"));
    try {
      const pendingPath = resolveSlackAuthPendingStorePath(dataDir);
      await mkdir(dirname(pendingPath), { recursive: true });
      await writeFile(pendingPath, "{invalid json", "utf8");

      const store = new SlackAuthTokenStore({ dataDir });
      const loaded = store.loadAllSync();
      assert.deepEqual(loaded.pending, []);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
