import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, describe, it } from "node:test";
import { ProviderRegistry, ToolHub } from "../../../src/assistant/dynamic-tool/index.js";
import type { ToolHubResult } from "../../../src/assistant/dynamic-tool/types.js";
import { resolveSlackCacheBaseDir } from "../../../src/runtime/data-paths.js";
import {
  createSlackDynamicProviderFromEnv as createProviderFromEnv,
  type SlackBrowserApiInvoker,
} from "../../../src/assistant/slack-api-tools/index.js";
import {
  configureSlackAuthTokenRegistry,
  flushSlackAuthTokenRegistryForTest,
  resetSlackAuthTokenCacheForTest,
  syncSlackAuthTokenSnapshots,
} from "../../../src/slack/slackAuthTokenRegistry.js";
import { SLACK_PENDING_ACCOUNT_ID } from "../../../src/slack/slackAuthTokenStore.js";

type BrowserCall = {
  endpoint: string;
  mode: string;
};

type BrowserScenario = {
  teamSearchError?: "not_allowed_token_type";
  teamSearchRateLimited?: boolean;
};

function createAuthProbeFetchStub(): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify({
        ok: true,
        team_id: "TTEAM",
        user_id: "UTEAM",
      }),
      { status: 200 }
    )) as typeof fetch;
}

function createBrowserInvokerStub(scenario: BrowserScenario = {}) {
  const calls: BrowserCall[] = [];

  const browserInvoker: SlackBrowserApiInvoker = async (input) => {
    calls.push({
      endpoint: input.endpoint,
      mode: input.mode,
    });

    if (input.endpoint === "auth.test") {
      if (input.mode === "enterprise") {
        return {
          status: 200,
          payload: {
            ok: true,
            team_id: "TENTER",
            enterprise_id: "EENTER",
            user_id: "UENT",
            url: "https://enterprise.slack.test/",
          },
        };
      }
      return {
        status: 200,
        payload: {
          ok: true,
          team_id: "TTEAM",
          user_id: "UTEAM",
          url: "https://team.slack.test/",
        },
      };
    }

    if (input.endpoint === "users.list") {
      return {
        status: 200,
        payload: {
          ok: true,
          members: [
            {
              id: "U123",
              name: "alice",
              real_name: "Alice Example",
              profile: { display_name: "alice" },
            },
          ],
          response_metadata: { next_cursor: "" },
        },
      };
    }

    if (input.endpoint === "conversations.list") {
      return {
        status: 200,
        payload: {
          ok: true,
          channels: [
            {
              id: "C123",
              name: "general",
              is_private: false,
              is_im: false,
              is_mpim: false,
            },
          ],
          response_metadata: { next_cursor: "" },
        },
      };
    }

    if (input.endpoint === "search.modules.channels") {
      return {
        status: 200,
        payload: {
          ok: true,
          items: [
            {
              id: "C123",
              name: "general",
              is_private: false,
              is_im: false,
              is_mpim: false,
            },
          ],
          pagination: { next_cursor: "" },
        },
      };
    }

    if (input.endpoint === "search.messages") {
      if (input.mode === "team" && scenario.teamSearchRateLimited) {
        return {
          status: 429,
          payload: {
            ok: false,
            error: "ratelimited",
          },
        };
      }
      if (input.mode === "team" && scenario.teamSearchError) {
        return {
          status: 200,
          payload: {
            ok: false,
            error: scenario.teamSearchError,
          },
        };
      }
      return {
        status: 200,
        payload: {
          ok: true,
          messages: {
            matches: [{ channel: { id: "C123" }, ts: "1710000000.000100", text: "hello" }],
          },
        },
      };
    }

    if (input.endpoint === "chat.postMessage") {
      return {
        status: 200,
        payload: {
          ok: true,
          channel: "C123",
          ts: "1710000000.000200",
          message: { text: "done" },
        },
      };
    }

    if (input.endpoint === "users.info") {
      return {
        status: 200,
        payload: {
          ok: true,
          user: {
            id: "U123",
            name: "alice",
            real_name: "Alice Example",
            profile: { display_name: "alice" },
          },
        },
      };
    }

    if (input.endpoint === "conversations.info" || input.endpoint === "conversations.genericInfo") {
      return {
        status: 200,
        payload: {
          ok: true,
          channel: {
            id: "C123",
            name: "general",
            is_private: false,
            is_im: false,
            is_mpim: false,
          },
          channels: [
            {
              id: "C123",
              name: "general",
              is_private: false,
              is_im: false,
              is_mpim: false,
            },
          ],
        },
      };
    }

    return {
      status: 404,
      payload: { ok: false, error: "unknown_endpoint" },
    };
  };

  return {
    browserInvoker,
    calls,
  };
}

function createEnv(
  dataDir: string,
  extra: Record<string, string | undefined> = {}
): NodeJS.ProcessEnv {
  return {
    ADJUTANT_SLACK_API_ENABLED: "1",
    ADJUTANT_SLACK_API_REQUEST_ENABLED: "1",
    ADJUTANT_SLACK_API_ROUTING_MODE: "auto_probe",
    DATA_DIR: dataDir,
    ...extra,
  };
}

async function seedAuthTokenCache(params: {
  dataDir: string;
  fetchFn: typeof fetch;
  workspaceKey?: string;
  xoxcToken?: string;
  xoxdToken?: string;
}): Promise<void> {
  configureSlackAuthTokenRegistry({
    dataDir: params.dataDir,
    fetchFn: params.fetchFn,
    authTestEnabled: true,
    authTestRetryDelaysMs: [1, 1, 1],
  });
  syncSlackAuthTokenSnapshots({
    snapshots: [
      {
        workspaceKey: params.workspaceKey ?? "TTEAM",
        tokens: {
          xoxc: {
            value: params.xoxcToken ?? "xoxc-from-cache",
            firstSeenAt: 1,
            lastSeenAt: 2,
            hits: 1,
            sourceStage: "requestWillBeSent",
          },
          xoxd: {
            value: params.xoxdToken ?? "xoxd-from-cache",
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
}

async function runTool(
  env: NodeJS.ProcessEnv,
  fetchFn: typeof fetch,
  browserInvoker: SlackBrowserApiInvoker,
  input: Record<string, unknown>
): Promise<ToolHubResult> {
  const provider = createProviderFromEnv({
    env,
    fetchFn,
    browserInvoker,
    dataDir: env.DATA_DIR,
  });
  const hub = new ToolHub(new ProviderRegistry([provider]));
  return await hub.execute(input);
}

describe("Slack provider integration", () => {
  beforeEach(() => {
    resetSlackAuthTokenCacheForTest();
  });

  it("env token 未設定でも s01 キャッシュがあれば users_list を実行できる", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "adjutant-slack-cache-fallback-"));
    const fetchFn = createAuthProbeFetchStub();
    const { browserInvoker } = createBrowserInvokerStub();
    const env = createEnv(dataDir, {});

    resetSlackAuthTokenCacheForTest();
    await seedAuthTokenCache({ dataDir, fetchFn });

    try {
      const result = await runTool(env, fetchFn, browserInvoker, {
        provider: "slack",
        action: "users_list",
        args: {},
      });

      assert.equal(result.ok, true);
      const executeData = result.ok
        ? (result.data as { ok?: boolean; data?: { users?: unknown[] } })
        : null;
      assert.equal(executeData?.ok, true);
      assert.equal(Array.isArray(executeData?.data?.users), true);
    } finally {
      resetSlackAuthTokenCacheForTest();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("users_list で既存 user-names-by-team キャッシュを更新する", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "adjutant-slack-users-cache-"));
    const fetchFn = createAuthProbeFetchStub();
    const { browserInvoker } = createBrowserInvokerStub();
    const env = createEnv(dataDir);
    await seedAuthTokenCache({ dataDir, fetchFn });

    try {
      const result = await runTool(env, fetchFn, browserInvoker, {
        provider: "slack",
        action: "users_list",
        args: {},
      });

      assert.equal(result.ok, true);
      const cacheBase = resolveSlackCacheBaseDir({
        dataDir,
        accountId: SLACK_PENDING_ACCOUNT_ID,
      });
      const cachePath = join(cacheBase, "user-names-by-team", "TTEAM.json");
      const raw = await readFile(cachePath, "utf8");
      const parsed = JSON.parse(raw) as {
        users?: Record<string, { profile?: { display_name?: string } }>;
      };
      assert.equal(parsed.users?.U123?.profile?.display_name, "alice");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("search_messages(auto_probe) は not_supported 時に enterprise へ fallback する", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "adjutant-slack-fallback-"));
    const fetchFn = createAuthProbeFetchStub();
    const { browserInvoker, calls } = createBrowserInvokerStub({
      teamSearchError: "not_allowed_token_type",
    });
    const env = createEnv(dataDir);
    await seedAuthTokenCache({ dataDir, fetchFn });

    try {
      const result = await runTool(env, fetchFn, browserInvoker, {
        provider: "slack",
        action: "search_messages",
        args: { query: "hello", routing_mode: "auto_probe" },
      });

      assert.equal(result.ok, true);
      if (!result.ok) {
        return;
      }
      const executeData = result.data as {
        ok?: boolean;
        modeUsed?: string;
        fallbackTried?: boolean;
        data?: { messages?: unknown[] };
      };
      assert.equal(executeData.ok, true);
      assert.equal(executeData.modeUsed, "enterprise");
      assert.equal(executeData.fallbackTried, true);
      assert.equal(Array.isArray(executeData.data?.messages), true);

      const teamSearchCalls = calls.filter(
        (call) => call.endpoint === "search.messages" && call.mode === "team"
      );
      const enterpriseSearchCalls = calls.filter(
        (call) => call.endpoint === "search.messages" && call.mode === "enterprise"
      );
      assert.equal(teamSearchCalls.length, 1);
      assert.equal(enterpriseSearchCalls.length, 1);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("search_messages(auto_probe) で 429 は fallback しない", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "adjutant-slack-rate-limited-"));
    const fetchFn = createAuthProbeFetchStub();
    const { browserInvoker, calls } = createBrowserInvokerStub({ teamSearchRateLimited: true });
    const env = createEnv(dataDir);
    await seedAuthTokenCache({ dataDir, fetchFn });

    try {
      const result = await runTool(env, fetchFn, browserInvoker, {
        provider: "slack",
        action: "search_messages",
        args: { query: "hello", routing_mode: "auto_probe" },
      });

      assert.equal(result.ok, true);
      if (!result.ok) {
        return;
      }
      const executeData = result.data as { ok?: boolean; code?: string };
      assert.equal(executeData.ok, false);
      assert.equal(executeData.code, "rate_limited");

      const teamSearchCalls = calls.filter(
        (call) => call.endpoint === "search.messages" && call.mode === "team"
      );
      const enterpriseSearchCalls = calls.filter(
        (call) => call.endpoint === "search.messages" && call.mode === "enterprise"
      );
      assert.equal(teamSearchCalls.length, 1);
      assert.equal(enterpriseSearchCalls.length, 0);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("token キャッシュ不在時は auth_invalid で失敗し HTTP 呼び出ししない", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "adjutant-slack-auth-invalid-"));
    const fetchFn = createAuthProbeFetchStub();
    const { browserInvoker, calls } = createBrowserInvokerStub();
    const env = createEnv(dataDir, {});

    try {
      const result = await runTool(env, fetchFn, browserInvoker, {
        provider: "slack",
        action: "users_list",
        args: {},
      });

      assert.equal(result.ok, true);
      if (!result.ok) {
        return;
      }
      const executeData = result.data as { ok?: boolean; code?: string };
      assert.equal(executeData.ok, false);
      assert.equal(executeData.code, "auth_invalid");
      assert.equal(calls.length, 0);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("authTest.enterpriseId を事前判定に使い channels_list を enterprise 経路で実行する", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "adjutant-slack-enterprise-preroute-"));
    const fetchFn: typeof fetch = (async () =>
      new Response(
        JSON.stringify({
          ok: true,
          team_id: "TTEAM",
          enterprise_id: "EENTER",
          user_id: "UTEAM",
          url: "https://enterprise.slack.test/",
        }),
        { status: 200 }
      )) as typeof fetch;
    const { browserInvoker, calls } = createBrowserInvokerStub();
    const env = createEnv(dataDir, {});
    await seedAuthTokenCache({ dataDir, fetchFn });

    try {
      const result = await runTool(env, fetchFn, browserInvoker, {
        provider: "slack",
        action: "channels_list",
        args: { routing_mode: "auto_probe" },
      });

      assert.equal(result.ok, true);
      if (!result.ok) {
        return;
      }
      const executeData = result.data as { ok?: boolean; modeUsed?: string };
      assert.equal(executeData.ok, true);
      assert.equal(executeData.modeUsed, "enterprise");

      const enterpriseSearchCalls = calls.filter(
        (call) => call.endpoint === "search.modules.channels" && call.mode === "enterprise"
      );
      const authTestCalls = calls.filter((call) => call.endpoint === "auth.test");
      assert.equal(enterpriseSearchCalls.length > 0, true);
      assert.equal(authTestCalls.length, 0);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
