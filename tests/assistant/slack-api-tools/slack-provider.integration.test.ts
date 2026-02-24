import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, describe, it } from "node:test";
import { ProviderRegistry, ToolHub } from "../../../src/assistant/dynamic-tool/index.js";
import type { ToolHubResult } from "../../../src/assistant/dynamic-tool/types.js";
import { normalizeAccountId, resolveSlackCacheBaseDir } from "../../../src/runtime/data-paths.js";
import { createSlackDynamicProviderFromEnv as createProviderFromEnv } from "../../../src/assistant/slack-api-tools/index.js";
import {
  resetSlackAuthTokenCacheForTest,
  syncSlackAuthTokenSnapshots,
} from "../../../src/slack/slackAuthTokenRegistry.js";

type FetchCall = {
  url: string;
  endpoint: string;
  route: string;
};

type FetchScenario = {
  teamSearchError?: "not_allowed_token_type";
  teamSearchRateLimited?: boolean;
};

function parseForm(body: BodyInit | null | undefined): URLSearchParams {
  if (typeof body === "string") {
    return new URLSearchParams(body);
  }
  if (body instanceof URLSearchParams) {
    return body;
  }
  return new URLSearchParams();
}

function createFetchStub(scenario: FetchScenario = {}) {
  const calls: FetchCall[] = [];

  const fetchFn: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const endpoint = url.split("/").filter(Boolean).slice(-1)[0] ?? "";
    const route = String(
      (init?.headers as Record<string, string> | undefined)?.["x-slack-route-mode"]
    );
    calls.push({ url, endpoint, route });

    const form = parseForm(init?.body);
    const token = form.get("token");
    if (!token?.startsWith("xoxc-")) {
      return new Response(JSON.stringify({ ok: false, error: "invalid_auth" }), { status: 200 });
    }

    if (endpoint === "auth.test") {
      if (route === "enterprise") {
        return new Response(
          JSON.stringify({
            ok: true,
            team_id: "TENTER",
            enterprise_id: "EENTER",
            user_id: "UENT",
            url: "https://enterprise.slack.test/",
          }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({
          ok: true,
          team_id: "TTEAM",
          user_id: "UTEAM",
          url: "https://team.slack.test/",
        }),
        { status: 200 }
      );
    }

    if (endpoint === "users.list") {
      return new Response(
        JSON.stringify({
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
        }),
        { status: 200 }
      );
    }

    if (endpoint === "conversations.list") {
      return new Response(
        JSON.stringify({
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
        }),
        { status: 200 }
      );
    }

    if (endpoint === "search.messages") {
      if (route === "team" && scenario.teamSearchRateLimited) {
        return new Response("too many requests", { status: 429 });
      }
      if (route === "team" && scenario.teamSearchError) {
        return new Response(JSON.stringify({ ok: false, error: scenario.teamSearchError }), {
          status: 200,
        });
      }
      return new Response(
        JSON.stringify({
          ok: true,
          messages: {
            matches: [{ channel: { id: "C123" }, ts: "1710000000.000100", text: "hello" }],
          },
        }),
        { status: 200 }
      );
    }

    if (endpoint === "chat.postMessage") {
      return new Response(
        JSON.stringify({
          ok: true,
          channel: "C123",
          ts: "1710000000.000200",
          message: { text: "done" },
        }),
        { status: 200 }
      );
    }

    if (endpoint === "users.info") {
      return new Response(
        JSON.stringify({
          ok: true,
          user: {
            id: "U123",
            name: "alice",
            real_name: "Alice Example",
            profile: { display_name: "alice" },
          },
        }),
        { status: 200 }
      );
    }

    if (endpoint === "conversations.info") {
      return new Response(
        JSON.stringify({
          ok: true,
          channel: {
            id: "C123",
            name: "general",
            is_private: false,
            is_im: false,
            is_mpim: false,
          },
        }),
        { status: 200 }
      );
    }

    return new Response(JSON.stringify({ ok: false, error: "unknown_endpoint" }), { status: 404 });
  }) as typeof fetch;

  return {
    fetchFn,
    calls,
  };
}

function createEnv(
  dataDir: string,
  extra: Record<string, string | undefined> = {}
): NodeJS.ProcessEnv {
  return {
    ADJUTANT_SLACK_API_ENABLED: "1",
    ADJUTANT_SLACK_XOXC_TOKEN: "xoxc-111",
    ADJUTANT_SLACK_XOXD_TOKEN: "xoxd-222",
    ADJUTANT_SLACK_API_ROUTING_MODE: "auto_probe",
    ADJUTANT_SLACK_TEAM_API_BASE_URL: "https://team.slack.test/api",
    ADJUTANT_SLACK_ENTERPRISE_API_BASE_URL: "https://enterprise.slack.test/api",
    DATA_DIR: dataDir,
    ...extra,
  };
}

async function runTool(
  env: NodeJS.ProcessEnv,
  fetchFn: typeof fetch,
  input: Record<string, unknown>
): Promise<ToolHubResult> {
  const provider = createProviderFromEnv({ env, fetchFn, dataDir: env.DATA_DIR });
  const hub = new ToolHub(new ProviderRegistry([provider]));
  return await hub.execute(input);
}

describe("Slack provider integration", () => {
  beforeEach(() => {
    resetSlackAuthTokenCacheForTest();
  });

  it("env token 未設定でも s01 キャッシュがあれば users_list を実行できる", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "adjutant-slack-cache-fallback-"));
    const { fetchFn } = createFetchStub();
    const env = createEnv(dataDir, {
      ADJUTANT_SLACK_XOXC_TOKEN: "",
      ADJUTANT_SLACK_XOXD_TOKEN: "",
      ADJUTANT_SLACK_ACCOUNT_ID: "acct-cache",
    });

    resetSlackAuthTokenCacheForTest();
    syncSlackAuthTokenSnapshots({
      accountId: env.ADJUTANT_SLACK_ACCOUNT_ID,
      snapshots: [
        {
          workspaceKey: "TTEAM",
          tokens: {
            xoxc: {
              value: "xoxc-from-cache",
              firstSeenAt: 1,
              lastSeenAt: 2,
              hits: 1,
              sourceStage: "requestWillBeSent",
            },
            xoxd: {
              value: "xoxd-from-cache",
              firstSeenAt: 1,
              lastSeenAt: 2,
              hits: 1,
              sourceStage: "requestWillBeSentExtraInfo",
            },
          },
        },
      ],
    });

    try {
      const result = await runTool(env, fetchFn, {
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
    const { fetchFn } = createFetchStub();
    const env = createEnv(dataDir);

    try {
      const result = await runTool(env, fetchFn, {
        provider: "slack",
        action: "users_list",
        args: {},
      });

      assert.equal(result.ok, true);
      const accountId = normalizeAccountId(env.ADJUTANT_SLACK_ACCOUNT_ID, "default");
      const cacheBase = resolveSlackCacheBaseDir({ dataDir, accountId });
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
    const { fetchFn, calls } = createFetchStub({ teamSearchError: "not_allowed_token_type" });
    const env = createEnv(dataDir);

    try {
      const result = await runTool(env, fetchFn, {
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
        (call) => call.endpoint === "search.messages" && call.route === "team"
      );
      const enterpriseSearchCalls = calls.filter(
        (call) => call.endpoint === "search.messages" && call.route === "enterprise"
      );
      assert.equal(teamSearchCalls.length, 1);
      assert.equal(enterpriseSearchCalls.length, 1);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("search_messages(auto_probe) で 429 は fallback しない", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "adjutant-slack-rate-limited-"));
    const { fetchFn, calls } = createFetchStub({ teamSearchRateLimited: true });
    const env = createEnv(dataDir);

    try {
      const result = await runTool(env, fetchFn, {
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
        (call) => call.endpoint === "search.messages" && call.route === "team"
      );
      const enterpriseSearchCalls = calls.filter(
        (call) => call.endpoint === "search.messages" && call.route === "enterprise"
      );
      assert.equal(teamSearchCalls.length, 1);
      assert.equal(enterpriseSearchCalls.length, 0);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("xoxd 不在時は auth_invalid で失敗し HTTP 呼び出ししない", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "adjutant-slack-auth-invalid-"));
    const { fetchFn, calls } = createFetchStub();
    const env = createEnv(dataDir, { ADJUTANT_SLACK_XOXD_TOKEN: "" });

    try {
      const result = await runTool(env, fetchFn, {
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
});
