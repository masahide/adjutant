import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import {
  configureSlackAuthTokenRegistry,
  flushSlackAuthTokenRegistryForTest,
  getSlackAuthTokenRegistrySnapshotForTest,
  listSlackAuthWorkspacesFromCache,
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

  it("xoxc/xoxd ペア成立時に token pair callback を発火する", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "adjutant-auth-registry-token-pair-"));
    const tokenPairs: Array<{
      workspaceKey: string;
      accountId?: string;
      xoxcToken: string;
      xoxdToken: string;
    }> = [];

    try {
      resetSlackAuthTokenCacheForTest();
      configureSlackAuthTokenRegistry({
        dataDir,
        authTestEnabled: false,
        onTokenPairReady: async (event) => {
          tokenPairs.push({
            workspaceKey: event.workspaceKey,
            accountId: event.accountId,
            xoxcToken: event.xoxcToken,
            xoxdToken: event.xoxdToken,
          });
        },
      });

      syncSlackAuthTokenSnapshots({
        snapshots: [
          {
            workspaceKey: "workspace-pair",
            tokens: {
              xoxc: {
                value: "xoxc-pair",
                firstSeenAt: 1,
                lastSeenAt: 1,
                hits: 1,
                sourceStage: "requestWillBeSent",
              },
              xoxd: {
                value: "xoxd-pair",
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

      assert.equal(tokenPairs.length, 1);
      assert.equal(tokenPairs[0]?.workspaceKey, "workspace-pair");
      assert.equal(tokenPairs[0]?.accountId, undefined);
      assert.equal(tokenPairs[0]?.xoxcToken, "xoxc-pair");
      assert.equal(tokenPairs[0]?.xoxdToken, "xoxd-pair");
    } finally {
      resetSlackAuthTokenCacheForTest();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("requestId が不一致な xoxc/xoxd ペアは登録対象から除外する", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "adjutant-auth-registry-token-mismatch-"));
    const tokenPairs: Array<{ workspaceKey: string }> = [];
    const warnings: Array<{ message: string; meta?: Record<string, unknown> }> = [];

    try {
      resetSlackAuthTokenCacheForTest();
      configureSlackAuthTokenRegistry({
        dataDir,
        authTestEnabled: false,
        onTokenPairReady: async (event) => {
          tokenPairs.push({ workspaceKey: event.workspaceKey });
        },
        onWarn: (message, meta) => {
          warnings.push({ message, meta });
        },
      });

      syncSlackAuthTokenSnapshots({
        snapshots: [
          {
            workspaceKey: "workspace-mismatch",
            tokens: {
              xoxc: {
                value: "xoxc-mismatch",
                firstSeenAt: 1,
                lastSeenAt: 1,
                hits: 1,
                sourceStage: "requestWillBeSent",
                requestId: "req-1",
              },
              xoxd: {
                value: "xoxd-mismatch",
                firstSeenAt: 1,
                lastSeenAt: 1,
                hits: 1,
                sourceStage: "requestWillBeSentExtraInfo",
                requestId: "req-2",
              },
            },
          },
        ],
      });
      await flushSlackAuthTokenRegistryForTest();

      assert.equal(tokenPairs.length, 0);
      assert.equal(warnings.length, 1);
      assert.equal(warnings[0]?.message, "slack-auth-token-snapshot-skipped");
      assert.equal(warnings[0]?.meta?.reason, "incoherent_token_pair");

      const snapshot = getSlackAuthTokenRegistrySnapshotForTest();
      assert.equal(snapshot.pending.length, 0);
    } finally {
      resetSlackAuthTokenCacheForTest();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("起動時 hydrate された token pair に対して callback を発火する", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "adjutant-auth-registry-token-hydrate-"));
    const hydratedPairs: Array<{ workspaceKey: string; xoxcToken: string; xoxdToken: string }> = [];
    try {
      resetSlackAuthTokenCacheForTest();
      configureSlackAuthTokenRegistry({
        dataDir,
        authTestEnabled: false,
      });
      syncSlackAuthTokenSnapshots({
        snapshots: [
          {
            workspaceKey: "workspace-hydrate",
            tokens: {
              xoxc: {
                value: "xoxc-hydrate",
                firstSeenAt: 1,
                lastSeenAt: 1,
                hits: 1,
                sourceStage: "requestWillBeSent",
              },
              xoxd: {
                value: "xoxd-hydrate",
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

      resetSlackAuthTokenCacheForTest();
      configureSlackAuthTokenRegistry({
        dataDir,
        authTestEnabled: false,
        onTokenPairReady: async (event) => {
          hydratedPairs.push({
            workspaceKey: event.workspaceKey,
            xoxcToken: event.xoxcToken,
            xoxdToken: event.xoxdToken,
          });
        },
      });
      await flushSlackAuthTokenRegistryForTest();

      assert.equal(hydratedPairs.length, 1);
      assert.equal(hydratedPairs[0]?.workspaceKey, "workspace-hydrate");
      assert.equal(hydratedPairs[0]?.xoxcToken, "xoxc-hydrate");
      assert.equal(hydratedPairs[0]?.xoxdToken, "xoxd-hydrate");
    } finally {
      resetSlackAuthTokenCacheForTest();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("auth.test ログに token を含めない", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "adjutant-auth-registry-log-safety-"));
    const xoxcSecret = "xoxc-secret-token-value";
    const xoxdSecret = "xoxd-secret-token-value";
    const logged: string[] = [];
    const originalInfo = console.info;

    try {
      const fetchFn: typeof fetch = (async () => {
        return new Response(
          JSON.stringify({
            ok: true,
            team_id: "TSAFE",
            enterprise_id: "ESAFE",
            user_id: "USAFE",
            url: "https://workspace-safe.slack.com/",
          }),
          { status: 200 }
        );
      }) as typeof fetch;

      console.info = (...args: unknown[]) => {
        logged.push(args.map((arg) => String(arg)).join(" "));
      };

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
            workspaceKey: "workspace-safe",
            tokens: {
              xoxc: {
                value: xoxcSecret,
                firstSeenAt: 1,
                lastSeenAt: 2,
                hits: 1,
                sourceStage: "requestWillBeSent",
              },
              xoxd: {
                value: xoxdSecret,
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

      const serialized = logged.join("\n");
      assert.equal(serialized.includes("[SlackAuthTest]"), true);
      assert.equal(serialized.includes(xoxcSecret), false);
      assert.equal(serialized.includes(xoxdSecret), false);
    } finally {
      console.info = originalInfo;
      resetSlackAuthTokenCacheForTest();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("workspace 一覧は token 非公開で取得できる", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "adjutant-auth-registry-list-"));
    const nowA = Date.now();
    const nowB = nowA + 1000;
    try {
      const fetchFn: typeof fetch = (async () => {
        return new Response(
          JSON.stringify({
            ok: true,
            team_id: "T-LIST",
            enterprise_id: "E-LIST",
            user_id: "U-LIST",
            url: "https://workspace-list.slack.com/",
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
            workspaceKey: "workspace-account",
            tokens: {
              xoxc: {
                value: "xoxc-account",
                firstSeenAt: 1,
                lastSeenAt: nowA,
                hits: 1,
                sourceStage: "requestWillBeSent",
              },
              xoxd: {
                value: "xoxd-account",
                firstSeenAt: 1,
                lastSeenAt: nowA,
                hits: 1,
                sourceStage: "requestWillBeSentExtraInfo",
              },
            },
          },
        ],
      });
      await flushSlackAuthTokenRegistryForTest();

      configureSlackAuthTokenRegistry({
        dataDir,
        authTestEnabled: false,
        fetchFn,
      });
      syncSlackAuthTokenSnapshots({
        snapshots: [
          {
            workspaceKey: "workspace-pending",
            tokens: {
              xoxc: {
                value: "xoxc-pending",
                firstSeenAt: 1,
                lastSeenAt: nowB,
                hits: 1,
                sourceStage: "requestWillBeSent",
              },
              xoxd: {
                value: "xoxd-pending",
                firstSeenAt: 1,
                lastSeenAt: nowB,
                hits: 1,
                sourceStage: "requestWillBeSentExtraInfo",
              },
            },
          },
        ],
      });
      await flushSlackAuthTokenRegistryForTest();

      const listed = listSlackAuthWorkspacesFromCache();
      assert.equal(listed.length >= 2, true);
      assert.equal(listed[0]?.workspaceKey, "workspace-pending");
      assert.equal(
        listed.some((item) => item.workspaceKey === "workspace-account"),
        true
      );
      assert.equal(
        listed.some((item) => Object.prototype.hasOwnProperty.call(item, "xoxcToken")),
        false
      );

      const byAccountOnly = listSlackAuthWorkspacesFromCache({
        accountId: "E-LIST",
        includePending: false,
      });
      assert.equal(byAccountOnly.length, 1);
      assert.equal(byAccountOnly[0]?.workspaceKey, "workspace-account");
      assert.equal(byAccountOnly[0]?.accountId, "E-LIST");
      assert.equal(byAccountOnly[0]?.authTestStatus, "ok");
    } finally {
      resetSlackAuthTokenCacheForTest();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
