import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import {
  configureSlackAuthTokenRegistry,
  flushSlackAuthTokenRegistryForTest,
  getSlackAuthTokenRegistrySnapshotForTest,
  resetSlackAuthTokenCacheForTest,
  resolveSlackAuthTokensFromCache,
  syncSlackAuthTokenSnapshots,
} from "../../src/slack/slackAuthTokenRegistry.js";

describe("slackAuthTokenRegistry", () => {
  it("authTestEnabled 未指定時は auth.test を自動実行しない", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "adjutant-auth-registry-disabled-"));
    const calls: number[] = [];
    try {
      const fetchFn: typeof fetch = (async () => {
        calls.push(1);
        return new Response(JSON.stringify({ ok: true, team_id: "T000", user_id: "U000" }), {
          status: 200,
        });
      }) as typeof fetch;

      resetSlackAuthTokenCacheForTest();
      configureSlackAuthTokenRegistry({
        dataDir,
        fetchFn,
      });

      syncSlackAuthTokenSnapshots({
        snapshots: [
          {
            workspaceKey: "workspace-disabled",
            tokens: {
              xoxc: {
                value: "xoxc-disabled",
                firstSeenAt: 1,
                lastSeenAt: 1,
                hits: 1,
                sourceStage: "requestWillBeSent",
              },
              xoxd: {
                value: "xoxd-disabled",
                firstSeenAt: 1,
                lastSeenAt: 1,
                hits: 1,
                sourceStage: "requestWillBeSentExtraInfo",
              },
            },
          },
        ],
      });
      await flushSlackAuthTokenRegistryForTest();

      assert.equal(calls.length, 0);
      const snapshot = getSlackAuthTokenRegistrySnapshotForTest();
      assert.equal(snapshot.pending.length, 1);
      assert.equal(snapshot.pending[0]?.workspaceKey, "workspace-disabled");
    } finally {
      resetSlackAuthTokenCacheForTest();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("auth.test 成功時に _pending から account ストアへ昇格する", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "adjutant-auth-registry-promote-"));
    try {
      const fetchFn: typeof fetch = (async () => {
        return new Response(
          JSON.stringify({
            ok: true,
            team_id: "T12345",
            enterprise_id: "E99999",
            user_id: "U11111",
            url: "https://workspace-a.slack.com/",
          }),
          { status: 200 }
        );
      }) as typeof fetch;

      resetSlackAuthTokenCacheForTest();
      configureSlackAuthTokenRegistry({
        dataDir,
        authTestEnabled: true,
        fetchFn,
        authTestRetryDelaysMs: [1, 1, 1],
      });

      syncSlackAuthTokenSnapshots({
        snapshots: [
          {
            workspaceKey: "workspace-a",
            tokens: {
              xoxc: {
                value: "xoxc-111",
                firstSeenAt: 1,
                lastSeenAt: 2,
                hits: 1,
                sourceStage: "requestWillBeSent",
              },
              xoxd: {
                value: "xoxd-222",
                firstSeenAt: 1,
                lastSeenAt: 2,
                hits: 1,
                sourceStage: "requestWillBeSentExtraInfo",
              },
            },
          },
        ],
      });
      await flushSlackAuthTokenRegistryForTest();

      const snapshot = getSlackAuthTokenRegistrySnapshotForTest();
      assert.equal(snapshot.pending.length, 0);
      assert.equal(snapshot.byAccount.E99999?.length, 1);

      const byTeam = resolveSlackAuthTokensFromCache({ workspaceKey: "T12345" });
      assert.equal(byTeam?.workspaceKey, "workspace-a");
      assert.equal(byTeam?.xoxcToken, "xoxc-111");
      assert.equal(byTeam?.xoxdToken, "xoxd-222");

      const byEnterprise = resolveSlackAuthTokensFromCache({ workspaceKey: "E99999" });
      assert.equal(byEnterprise?.workspaceKey, "workspace-a");
    } finally {
      resetSlackAuthTokenCacheForTest();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("invalid_auth は同一 token pair で再試行しない", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "adjutant-auth-registry-invalid-"));
    const calls: number[] = [];
    try {
      const fetchFn: typeof fetch = (async () => {
        calls.push(1);
        return new Response(JSON.stringify({ ok: false, error: "invalid_auth" }), { status: 200 });
      }) as typeof fetch;

      resetSlackAuthTokenCacheForTest();
      configureSlackAuthTokenRegistry({
        dataDir,
        authTestEnabled: true,
        fetchFn,
        authTestRetryDelaysMs: [1, 1, 1],
      });

      syncSlackAuthTokenSnapshots({
        snapshots: [
          {
            workspaceKey: "workspace-b",
            tokens: {
              xoxc: {
                value: "xoxc-aaa",
                firstSeenAt: 1,
                lastSeenAt: 1,
                hits: 1,
                sourceStage: "requestWillBeSent",
              },
              xoxd: {
                value: "xoxd-aaa",
                firstSeenAt: 1,
                lastSeenAt: 1,
                hits: 1,
                sourceStage: "requestWillBeSentExtraInfo",
              },
            },
          },
        ],
      });
      await flushSlackAuthTokenRegistryForTest();
      assert.equal(calls.length, 1);

      syncSlackAuthTokenSnapshots({
        snapshots: [
          {
            workspaceKey: "workspace-b",
            tokens: {
              xoxc: {
                value: "xoxc-aaa",
                firstSeenAt: 1,
                lastSeenAt: 2,
                hits: 2,
                sourceStage: "requestWillBeSent",
              },
              xoxd: {
                value: "xoxd-aaa",
                firstSeenAt: 1,
                lastSeenAt: 2,
                hits: 2,
                sourceStage: "requestWillBeSentExtraInfo",
              },
            },
          },
        ],
      });
      await flushSlackAuthTokenRegistryForTest();
      assert.equal(calls.length, 1);

      syncSlackAuthTokenSnapshots({
        snapshots: [
          {
            workspaceKey: "workspace-b",
            tokens: {
              xoxc: {
                value: "xoxc-bbb",
                firstSeenAt: 3,
                lastSeenAt: 3,
                hits: 1,
                sourceStage: "requestWillBeSent",
              },
              xoxd: {
                value: "xoxd-bbb",
                firstSeenAt: 3,
                lastSeenAt: 3,
                hits: 1,
                sourceStage: "requestWillBeSentExtraInfo",
              },
            },
          },
        ],
      });
      await flushSlackAuthTokenRegistryForTest();
      assert.equal(calls.length, 2);
    } finally {
      resetSlackAuthTokenCacheForTest();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("auth.test 成功時に workspace promotion callback を発火する", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "adjutant-auth-registry-callback-"));
    const promoted: Array<{
      workspaceKey: string;
      accountId: string;
      teamId?: string;
      enterpriseId?: string;
      aliases: string[];
    }> = [];

    try {
      const fetchFn: typeof fetch = (async () => {
        return new Response(
          JSON.stringify({
            ok: true,
            team_id: "T77777",
            enterprise_id: "E77777",
            user_id: "U77777",
            url: "https://workspace-c.slack.com/",
          }),
          { status: 200 }
        );
      }) as typeof fetch;

      resetSlackAuthTokenCacheForTest();
      configureSlackAuthTokenRegistry({
        dataDir,
        authTestEnabled: true,
        fetchFn,
        onWorkspacePromoted: async (event) => {
          promoted.push({
            workspaceKey: event.workspaceKey,
            accountId: event.accountId,
            teamId: event.teamId,
            enterpriseId: event.enterpriseId,
            aliases: [...event.aliases],
          });
        },
      });

      syncSlackAuthTokenSnapshots({
        snapshots: [
          {
            workspaceKey: "workspace-c",
            tokens: {
              xoxc: {
                value: "xoxc-c",
                firstSeenAt: 1,
                lastSeenAt: 1,
                hits: 1,
                sourceStage: "requestWillBeSent",
              },
              xoxd: {
                value: "xoxd-c",
                firstSeenAt: 1,
                lastSeenAt: 1,
                hits: 1,
                sourceStage: "requestWillBeSentExtraInfo",
              },
            },
          },
        ],
      });
      await flushSlackAuthTokenRegistryForTest();

      assert.equal(promoted.length, 1);
      assert.equal(promoted[0]?.workspaceKey, "workspace-c");
      assert.equal(promoted[0]?.accountId, "E77777");
      assert.equal(promoted[0]?.teamId, "T77777");
      assert.equal(promoted[0]?.enterpriseId, "E77777");
      assert.equal(promoted[0]?.aliases.includes("workspace-c"), true);
      assert.equal(promoted[0]?.aliases.includes("T77777"), true);
    } finally {
      resetSlackAuthTokenCacheForTest();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
