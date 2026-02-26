import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ProviderRegistry, ToolHub } from "../../../src/assistant/dynamic-tool/index.js";
import { createSlackDynamicProviderFromEnv } from "../../../src/assistant/slack-api-tools/index.js";

type JsonRpcRequest = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
};

type ToolCall = {
  name: string;
  args: Record<string, unknown>;
};

function parseBody(init: RequestInit | undefined): JsonRpcRequest {
  const raw = typeof init?.body === "string" ? init.body : "{}";
  return JSON.parse(raw) as JsonRpcRequest;
}

function createRpcFetchStub(
  onToolCall: (name: string, args: Record<string, unknown>) => Record<string, unknown>
): {
  fetchFn: typeof fetch;
  calls: ToolCall[];
} {
  const calls: ToolCall[] = [];
  const fetchFn: typeof fetch = (async (_url, init) => {
    const body = parseBody(init);
    if (body.method === "initialize") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { ok: true } }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "Mcp-Session-Id": "session-1",
        },
      });
    }

    if (body.method === "tools/call") {
      const params = (body.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
      const name = typeof params.name === "string" ? params.name : "";
      const args = params.arguments ?? {};
      calls.push({ name, args });
      const structuredContent = onToolCall(name, args);
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            content: [{ type: "text", text: "ok" }],
            structuredContent,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { message: "unsupported" } }),
      {
        status: 400,
        headers: { "content-type": "application/json" },
      }
    );
  }) as typeof fetch;

  return { fetchFn, calls };
}

describe("Slack provider integration (JSON-RPC)", () => {
  it("catalog は Slack action 12個を返す", async () => {
    const { fetchFn } = createRpcFetchStub(() => ({ ok: true }));
    const provider = createSlackDynamicProviderFromEnv({
      env: {
        ADJUTANT_SLACK_API_ENABLED: "1",
        ADJUTANT_SLACK_RPC_ENABLED: "1",
        ADJUTANT_SLACK_RPC_BASE_URL: "http://unit.test",
      } as NodeJS.ProcessEnv,
      fetchFn,
    });
    const hub = new ToolHub(new ProviderRegistry([provider]));
    const result = await hub.execute({ provider: "slack" });
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    const actions = (result.data as { actions?: Array<{ name?: string }> }).actions ?? [];
    assert.equal(actions.length, 12);
    const names = actions.map((action) => action.name);
    assert.deepEqual(names, [
      "workspaces_list",
      "workspace_register",
      "workspace_unregister",
      "users_list",
      "channels_list",
      "get_user_info",
      "get_channel_info",
      "get_user_name_by_id",
      "get_channel_name_by_id",
      "search_messages",
      "post_message",
      "auth_test",
    ]);
  });

  it("workspace_key 必須 action は未指定時に validation_error を返し RPC を呼ばない", async () => {
    const { fetchFn, calls } = createRpcFetchStub(() => ({ ok: true }));
    const provider = createSlackDynamicProviderFromEnv({
      env: {
        ADJUTANT_SLACK_API_ENABLED: "1",
        ADJUTANT_SLACK_RPC_ENABLED: "1",
        ADJUTANT_SLACK_RPC_BASE_URL: "http://unit.test",
      } as NodeJS.ProcessEnv,
      fetchFn,
    });
    const hub = new ToolHub(new ProviderRegistry([provider]));
    const result = await hub.execute({
      provider: "slack",
      action: "users_list",
      args: {},
    });
    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.equal(result.code, "validation_error");
    assert.equal(calls.length, 0);
  });

  it("auth_test は tools/call(name=auth_test) を実行し結果を返す", async () => {
    const { fetchFn, calls } = createRpcFetchStub((name, args) => {
      if (name === "auth_test") {
        return {
          workspace_key: args.workspace_key,
          team_id: "T123",
          enterprise_id: "E123",
          url: "https://acme.slack.com/",
          user_id: "U123",
        };
      }
      return { ok: true };
    });
    const provider = createSlackDynamicProviderFromEnv({
      env: {
        ADJUTANT_SLACK_API_ENABLED: "1",
        ADJUTANT_SLACK_RPC_ENABLED: "1",
        ADJUTANT_SLACK_RPC_BASE_URL: "http://unit.test",
      } as NodeJS.ProcessEnv,
      fetchFn,
    });
    const hub = new ToolHub(new ProviderRegistry([provider]));
    const result = await hub.execute({
      provider: "slack",
      action: "auth_test",
      args: { workspace_key: "acme" },
    });
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    const data = result.data as {
      ok?: boolean;
      data?: { team_id?: string; enterprise_id?: string; url?: string; user_id?: string };
    };
    assert.equal(data.ok, true);
    assert.equal(data.data?.team_id, "T123");
    assert.equal(data.data?.enterprise_id, "E123");
    assert.equal(data.data?.url, "https://acme.slack.com/");
    assert.equal(data.data?.user_id, "U123");

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.name, "auth_test");
    assert.deepEqual(calls[0]?.args, { workspace_key: "acme" });
  });

  it("workspace_register は xoxc/xoxd を Gateway に転送する", async () => {
    const { fetchFn, calls } = createRpcFetchStub((name, args) => {
      if (name === "workspace_register") {
        return {
          ok: true,
          workspace: {
            workspace_key: args.workspace_key,
          },
        };
      }
      return { ok: true };
    });
    const provider = createSlackDynamicProviderFromEnv({
      env: {
        ADJUTANT_SLACK_API_ENABLED: "1",
        ADJUTANT_SLACK_RPC_ENABLED: "1",
        ADJUTANT_SLACK_RPC_BASE_URL: "http://unit.test",
      } as NodeJS.ProcessEnv,
      fetchFn,
    });
    const hub = new ToolHub(new ProviderRegistry([provider]));
    const result = await hub.execute({
      provider: "slack",
      action: "workspace_register",
      args: {
        workspace_key: "acme",
        xoxc: "xoxc-abc",
        xoxd: "xoxd-abc",
      },
    });
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.name, "workspace_register");
    assert.deepEqual(calls[0]?.args, {
      workspace_key: "acme",
      xoxc: "xoxc-abc",
      xoxd: "xoxd-abc",
    });
  });

  it("workspace_register は workspace_key 未指定でも実行できる", async () => {
    const { fetchFn, calls } = createRpcFetchStub((name, _args) => {
      if (name === "workspace_register") {
        return {
          ok: true,
          workspace: {
            workspace_key: "E-AUTO",
          },
        };
      }
      return { ok: true };
    });
    const provider = createSlackDynamicProviderFromEnv({
      env: {
        ADJUTANT_SLACK_API_ENABLED: "1",
        ADJUTANT_SLACK_RPC_ENABLED: "1",
        ADJUTANT_SLACK_RPC_BASE_URL: "http://unit.test",
      } as NodeJS.ProcessEnv,
      fetchFn,
    });
    const hub = new ToolHub(new ProviderRegistry([provider]));
    const result = await hub.execute({
      provider: "slack",
      action: "workspace_register",
      args: {
        xoxc: "xoxc-abc",
        xoxd: "xoxd-abc",
      },
    });
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.name, "workspace_register");
    assert.deepEqual(calls[0]?.args, {
      xoxc: "xoxc-abc",
      xoxd: "xoxd-abc",
    });
  });
});
