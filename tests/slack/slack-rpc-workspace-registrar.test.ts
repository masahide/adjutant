import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSlackRpcWorkspaceRegistrarFromEnv } from "../../src/slack/slack-rpc-workspace-registrar.js";

type JsonRpcRequest = {
  id?: number;
  method?: string;
  params?: {
    name?: string;
    arguments?: Record<string, unknown>;
  };
};

function parseBody(init: RequestInit | undefined): JsonRpcRequest {
  const raw = typeof init?.body === "string" ? init.body : "{}";
  return JSON.parse(raw) as JsonRpcRequest;
}

describe("slack-rpc-workspace-registrar", () => {
  it("workspace_register 成功時は auth_test を情報ログに含める", async () => {
    const infos: Array<{ message: string; meta?: Record<string, unknown> }> = [];

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
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              isError: false,
              content: [{ type: "text", text: "ok" }],
              structuredContent: {
                ok: true,
                workspace: { workspace_key: "T-REGISTERED" },
                auth_test: {
                  workspace_key: "T-REGISTERED",
                  team_id: "T-REGISTERED",
                  user_id: "U-REGISTERED",
                },
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response("{}", { status: 400 });
    }) as typeof fetch;

    const registrar = createSlackRpcWorkspaceRegistrarFromEnv({
      env: {
        ADJUTANT_SLACK_RPC_ENABLED: "1",
        ADJUTANT_SLACK_RPC_BASE_URL: "http://127.0.0.1:8080",
      } as NodeJS.ProcessEnv,
      fetchFn,
      onInfo: (message, meta) => infos.push({ message, meta }),
    });

    await registrar.registerTokenPair({
      workspaceKey: "workspace-auth-test",
      aliases: ["workspace-auth-test"],
      xoxcToken: "xoxc-auth",
      xoxdToken: "xoxd-auth",
    });

    const succeeded = infos.find((entry) => entry.message === "slack-rpc-workspace-register-succeeded");
    assert.deepEqual(succeeded?.meta?.authTest, {
      workspace_key: "T-REGISTERED",
      team_id: "T-REGISTERED",
      user_id: "U-REGISTERED",
    });
  });

  it("同じ token pair の登録を重複実行しない", async () => {
    let initializeCount = 0;
    let registerCount = 0;

    const fetchFn: typeof fetch = (async (_url, init) => {
      const body = parseBody(init);
      if (body.method === "initialize") {
        initializeCount += 1;
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { ok: true } }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "Mcp-Session-Id": "session-1",
          },
        });
      }
      if (body.method === "tools/call") {
        registerCount += 1;
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              isError: false,
              content: [{ type: "text", text: "ok" }],
              structuredContent: {
                ok: true,
                workspace: { workspace_key: "T-REGISTERED" },
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response("{}", { status: 400 });
    }) as typeof fetch;

    const registrar = createSlackRpcWorkspaceRegistrarFromEnv({
      env: {
        ADJUTANT_SLACK_RPC_ENABLED: "1",
        ADJUTANT_SLACK_RPC_BASE_URL: "http://127.0.0.1:8080",
      } as NodeJS.ProcessEnv,
      fetchFn,
    });

    await registrar.registerTokenPair({
      workspaceKey: "workspace-a",
      aliases: ["workspace-a"],
      xoxcToken: "xoxc-a",
      xoxdToken: "xoxd-a",
    });
    await registrar.registerTokenPair({
      workspaceKey: "workspace-a",
      aliases: ["workspace-a"],
      xoxcToken: "xoxc-a",
      xoxdToken: "xoxd-a",
    });
    await registrar.registerTokenPair({
      workspaceKey: "workspace-a",
      aliases: ["workspace-a"],
      xoxcToken: "xoxc-a-new",
      xoxdToken: "xoxd-a",
    });

    assert.equal(initializeCount, 1);
    assert.equal(registerCount, 2);
  });

  it("already_exists は成功扱いで再実行しない", async () => {
    let registerCount = 0;
    const warnings: string[] = [];

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
        registerCount += 1;
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              isError: true,
              content: [{ type: "text", text: "already_exists" }],
              structuredContent: {
                ok: false,
                code: "already_exists",
                message: "workspace already exists",
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response("{}", { status: 400 });
    }) as typeof fetch;

    const registrar = createSlackRpcWorkspaceRegistrarFromEnv({
      env: {
        ADJUTANT_SLACK_RPC_ENABLED: "1",
        ADJUTANT_SLACK_RPC_BASE_URL: "http://127.0.0.1:8080",
      } as NodeJS.ProcessEnv,
      fetchFn,
      onWarn: (message) => warnings.push(message),
    });

    const event = {
      workspaceKey: "workspace-b",
      aliases: ["workspace-b"],
      xoxcToken: "xoxc-b",
      xoxdToken: "xoxd-b",
    };
    await registrar.registerTokenPair(event);
    await registrar.registerTokenPair(event);

    assert.equal(registerCount, 1);
    assert.equal(warnings.length, 0);
  });

  it("別workspace名でも同一 token pair の登録は 1 回だけ実行する", async () => {
    let registerCount = 0;
    const infos: Array<Record<string, unknown> | undefined> = [];

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
        registerCount += 1;
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              isError: false,
              content: [{ type: "text", text: "ok" }],
              structuredContent: {
                ok: true,
                workspace: { workspace_key: "T-REGISTERED" },
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response("{}", { status: 400 });
    }) as typeof fetch;

    const registrar = createSlackRpcWorkspaceRegistrarFromEnv({
      env: {
        ADJUTANT_SLACK_RPC_ENABLED: "1",
        ADJUTANT_SLACK_RPC_BASE_URL: "http://127.0.0.1:8080",
      } as NodeJS.ProcessEnv,
      fetchFn,
      onInfo: (_message, meta) => infos.push(meta),
    });

    await Promise.all([
      registrar.registerTokenPair({
        workspaceKey: "workspace-alias-a",
        aliases: ["workspace-alias-a"],
        xoxcToken: "xoxc-shared",
        xoxdToken: "xoxd-shared",
      }),
      registrar.registerTokenPair({
        workspaceKey: "workspace-alias-b",
        aliases: ["workspace-alias-b"],
        xoxcToken: "xoxc-shared",
        xoxdToken: "xoxd-shared",
      }),
    ]);

    assert.equal(registerCount, 1);
    assert.equal(
      infos.some((meta) => meta?.reason === "in_flight_token_pair"),
      true
    );
  });

  it("登録失敗時は warning を出し、同一 token pair でも再試行する", async () => {
    let registerCount = 0;
    const warnings: string[] = [];

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
        registerCount += 1;
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              isError: true,
              content: [{ type: "text", text: "validation_error" }],
              structuredContent: {
                ok: false,
                code: "validation_error",
                message: "xoxc is required",
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response("{}", { status: 400 });
    }) as typeof fetch;

    const registrar = createSlackRpcWorkspaceRegistrarFromEnv({
      env: {
        ADJUTANT_SLACK_RPC_ENABLED: "1",
        ADJUTANT_SLACK_RPC_BASE_URL: "http://127.0.0.1:8080",
      } as NodeJS.ProcessEnv,
      fetchFn,
      onWarn: (message) => warnings.push(message),
    });

    const event = {
      workspaceKey: "workspace-c",
      aliases: ["workspace-c"],
      xoxcToken: "xoxc-c",
      xoxdToken: "xoxd-c",
    };
    await registrar.registerTokenPair(event);
    await registrar.registerTokenPair(event);

    assert.equal(registerCount, 2);
    assert.equal(warnings.length, 2);
    assert.equal(
      warnings.every((message) => message === "slack-rpc-workspace-register-failed"),
      true
    );
  });

  it("workspace_key 必須エラー時は fallback 再試行せずに warning を出す", async () => {
    let registerCount = 0;
    const warningMeta: Array<Record<string, unknown> | undefined> = [];
    const argsList: Array<Record<string, unknown> | undefined> = [];

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
        registerCount += 1;
        argsList.push(body.params?.arguments);
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              isError: true,
              content: [{ type: "text", text: "workspace_key is required" }],
              structuredContent: {
                ok: false,
                code: "validation_error",
                message: "workspace_key is required",
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response("{}", { status: 400 });
    }) as typeof fetch;

    const registrar = createSlackRpcWorkspaceRegistrarFromEnv({
      env: {
        ADJUTANT_SLACK_RPC_ENABLED: "1",
        ADJUTANT_SLACK_RPC_BASE_URL: "http://127.0.0.1:8080",
      } as NodeJS.ProcessEnv,
      fetchFn,
      onWarn: (_message, meta) => warningMeta.push(meta),
    });

    await registrar.registerTokenPair({
      workspaceKey: "workspace-d",
      aliases: ["workspace-d"],
      xoxcToken: "xoxc-d",
      xoxdToken: "xoxd-d",
    });

    assert.equal(registerCount, 1);
    assert.deepEqual(argsList, [{ xoxc: "xoxc-d", xoxd: "xoxd-d" }]);
    assert.equal(warningMeta.length, 1);
    assert.equal(warningMeta[0]?.retry_with_workspace_key, undefined);
  });
});
