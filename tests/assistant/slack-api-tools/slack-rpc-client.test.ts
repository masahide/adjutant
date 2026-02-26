import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SlackRpcClientError,
  SlackRpcMcpClient,
} from "../../../src/assistant/slack-api-tools/index.js";

type JsonRpcRequest = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
};

function parseBody(input: RequestInit | undefined): JsonRpcRequest {
  const raw = typeof input?.body === "string" ? input.body : "{}";
  return JSON.parse(raw) as JsonRpcRequest;
}

describe("SlackRpcMcpClient", () => {
  it("initialize 後に tools/call を実行し session header を引き継ぐ", async () => {
    let initCalled = false;
    let toolCalled = false;
    let receivedSessionHeader: string | undefined;

    const fetchFn: typeof fetch = (async (_url, init) => {
      const body = parseBody(init);
      if (body.method === "initialize") {
        initCalled = true;
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { ok: true } }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "Mcp-Session-Id": "session-1",
          },
        });
      }
      if (body.method === "tools/call") {
        toolCalled = true;
        const headers = (init?.headers ?? {}) as Record<string, string>;
        receivedSessionHeader = headers["Mcp-Session-Id"] ?? headers["mcp-session-id"];
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              content: [{ type: "text", text: "ok" }],
              structuredContent: { ok: true, value: 1 },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response("{}", { status: 400 });
    }) as typeof fetch;

    const client = new SlackRpcMcpClient({
      baseUrl: "http://unit.test",
      fetchFn,
    });
    const result = await client.callTool("users_list", { workspace_key: "acme" });
    assert.equal(result.isError, false);
    assert.deepEqual(result.structuredContent, { ok: true, value: 1 });
    assert.equal(result.text, "ok");

    assert.equal(initCalled, true);
    assert.equal(toolCalled, true);
    assert.equal(receivedSessionHeader, "session-1");
  });

  it("session 404 を受けたら再 initialize して再試行する", async () => {
    let initializeCount = 0;
    let toolCallCount = 0;
    const fetchFn: typeof fetch = (async (_url, init) => {
      const body = parseBody(init);
      if (body.method === "initialize") {
        initializeCount += 1;
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { ok: true } }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "Mcp-Session-Id": `session-${initializeCount}`,
          },
        });
      }
      if (body.method === "tools/call") {
        toolCallCount += 1;
        const headers = (init?.headers ?? {}) as Record<string, string>;
        const sessionId = headers["Mcp-Session-Id"] ?? headers["mcp-session-id"];
        if (sessionId === "session-1") {
          return new Response("{}", {
            status: 404,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: { content: [{ type: "text", text: "ok" }], structuredContent: { ok: true } },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response("{}", { status: 400 });
    }) as typeof fetch;

    const client = new SlackRpcMcpClient({
      baseUrl: "http://unit.test",
      fetchFn,
    });
    const result = await client.callTool("users_list", { workspace_key: "acme" });
    assert.equal(result.isError, false);
    assert.equal(initializeCount, 2);
    assert.equal(toolCallCount, 2);
  });

  it("不正JSONレスポンス時は api_error になる", async () => {
    const fetchFn: typeof fetch = (async () =>
      new Response("{invalid-json", {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    const client = new SlackRpcMcpClient({
      baseUrl: "http://unit.test",
      fetchFn,
    });

    await assert.rejects(
      async () => {
        await client.callTool("users_list", { workspace_key: "acme" });
      },
      (error: unknown) => {
        assert.equal(error instanceof SlackRpcClientError, true);
        assert.equal((error as SlackRpcClientError).code, "api_error");
        return true;
      }
    );
  });
});
