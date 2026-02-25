import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createApiServer } from "../../src/assistant/api-server.js";
import { ProviderRegistry } from "../../src/assistant/dynamic-tool/registry.js";
import { ToolHub } from "../../src/assistant/dynamic-tool/hub.js";
import type { DynamicProvider } from "../../src/assistant/dynamic-tool/registry.js";

function createFakeProvider(): DynamicProvider {
  return {
    name: "fake",
    description: "Fake provider for testing",
    listActions: () => [
      {
        name: "greet",
        description: "Say hello",
        requiredArgs: ["name"],
        argsSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Who to greet" },
          },
        },
      },
      {
        name: "noop",
        description: "Do nothing",
        requiredArgs: [],
        argsSchema: { type: "object", properties: {} },
      },
    ],
    getAction: (actionName: string) => {
      const normalized = actionName.trim().toLowerCase();
      if (normalized === "greet") {
        return {
          descriptor: {
            name: "greet",
            description: "Say hello",
            requiredArgs: ["name"],
            argsSchema: {
              type: "object",
              properties: {
                name: { type: "string", description: "Who to greet" },
              },
            },
          },
          validate: (args: Record<string, unknown>) => {
            if (typeof args.name !== "string" || !args.name) {
              throw new Error("name is required");
            }
          },
          execute: async (args: Record<string, unknown>) => {
            return { ok: true, data: { greeting: `Hello, ${args.name}!` } };
          },
        };
      }
      if (normalized === "noop") {
        return {
          descriptor: {
            name: "noop",
            description: "Do nothing",
            requiredArgs: [],
            argsSchema: { type: "object", properties: {} },
          },
          validate: () => {},
          execute: async () => {
            return { ok: true, data: {} };
          },
        };
      }
      return undefined;
    },
  };
}

async function fetchJson(port: number, path: string, options?: RequestInit) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, options);
  const body = await res.json();
  return { status: res.status, body };
}

describe("api-server tools endpoints", () => {
  let stopServer: () => Promise<void>;
  let port: number;

  function createTestServer(config: {
    toolHub?: ToolHub;
    providerRegistry?: ProviderRegistry;
    workspaceListProvider?: () => unknown[];
  }) {
    port = 30_000 + Math.floor(Math.random() * 10_000);
    const api = createApiServer({
      port,
      host: "127.0.0.1",
      corsOrigin: "*",
      toolHub: config.toolHub,
      providerRegistry: config.providerRegistry,
      workspaceListProvider: config.workspaceListProvider,
    });
    stopServer = api.stop;
    return api;
  }

  afterEach(async () => {
    if (stopServer) {
      await stopServer();
    }
  });

  describe("GET /api/tools/catalog", () => {
    it("toolHub 未設定時は 501 を返す", async () => {
      const api = createTestServer({});
      await api.start();
      const { status, body } = await fetchJson(port, "/api/tools/catalog");
      assert.equal(status, 501);
      assert.equal(body.code, "NOT_IMPLEMENTED");
    });

    it("正常時はプロバイダー一覧とアクション一覧を返す", async () => {
      const registry = new ProviderRegistry([createFakeProvider()]);
      const hub = new ToolHub(registry);
      const api = createTestServer({ toolHub: hub, providerRegistry: registry });
      await api.start();

      const { status, body } = await fetchJson(port, "/api/tools/catalog");
      assert.equal(status, 200);
      assert.ok(Array.isArray(body.providers));
      assert.equal(body.providers.length, 1);

      const provider = body.providers[0];
      assert.equal(provider.name, "fake");
      assert.equal(provider.description, "Fake provider for testing");
      assert.ok(Array.isArray(provider.actions));
      assert.equal(provider.actions.length, 2);

      const greet = provider.actions.find((a: Record<string, unknown>) => a.name === "greet");
      assert.ok(greet);
      assert.deepEqual(greet.requiredArgs, ["name"]);
      assert.ok(greet.argsSchema);
    });
  });

  describe("POST /api/tools/execute", () => {
    it("toolHub 未設定時は 501 を返す", async () => {
      const api = createTestServer({});
      await api.start();
      const { status, body } = await fetchJson(port, "/api/tools/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "fake", action: "greet", args: { name: "World" } }),
      });
      assert.equal(status, 501);
      assert.equal(body.code, "NOT_IMPLEMENTED");
    });

    it("正常な実行結果を返す", async () => {
      const registry = new ProviderRegistry([createFakeProvider()]);
      const hub = new ToolHub(registry);
      const api = createTestServer({ toolHub: hub, providerRegistry: registry });
      await api.start();

      const { status, body } = await fetchJson(port, "/api/tools/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "fake", action: "greet", args: { name: "World" } }),
      });
      assert.equal(status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.mode, "execute");
      assert.equal(body.provider, "fake");
      assert.equal(body.action, "greet");
      assert.deepEqual(body.data, { ok: true, data: { greeting: "Hello, World!" } });
    });

    it("バリデーションエラー時は ok: false を返す", async () => {
      const registry = new ProviderRegistry([createFakeProvider()]);
      const hub = new ToolHub(registry);
      const api = createTestServer({ toolHub: hub, providerRegistry: registry });
      await api.start();

      const { status, body } = await fetchJson(port, "/api/tools/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "fake", action: "greet", args: {} }),
      });
      assert.equal(status, 200);
      assert.equal(body.ok, false);
      assert.equal(body.code, "validation_error");
    });

    it("存在しないプロバイダー指定時は ok: false を返す", async () => {
      const registry = new ProviderRegistry([createFakeProvider()]);
      const hub = new ToolHub(registry);
      const api = createTestServer({ toolHub: hub, providerRegistry: registry });
      await api.start();

      const { status, body } = await fetchJson(port, "/api/tools/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "unknown", action: "greet", args: {} }),
      });
      assert.equal(status, 200);
      assert.equal(body.ok, false);
      assert.equal(body.code, "unknown_provider");
    });
  });

  describe("GET /api/tools/workspaces", () => {
    it("workspaceListProvider 未設定時は空配列を返す", async () => {
      const api = createTestServer({});
      await api.start();
      const { status, body } = await fetchJson(port, "/api/tools/workspaces");
      assert.equal(status, 200);
      assert.deepEqual(body.workspaces, []);
    });

    it("正常時はワークスペース一覧をスネークケースで返す", async () => {
      const workspaces = [
        {
          workspaceKey: "T123",
          aliases: ["team-a"],
          accountId: "E456",
          hasTokens: true,
          authTestStatus: "ok",
          lastSeenAt: 1740000000000,
        },
      ];
      const api = createTestServer({
        workspaceListProvider: () => workspaces,
      });
      await api.start();

      const { status, body } = await fetchJson(port, "/api/tools/workspaces");
      assert.equal(status, 200);
      assert.ok(Array.isArray(body.workspaces));
      assert.equal(body.workspaces.length, 1);
      assert.equal(body.workspaces[0].workspace_key, "T123");
      assert.deepEqual(body.workspaces[0].aliases, ["team-a"]);
      assert.equal(body.workspaces[0].account_id, "E456");
      assert.equal(body.workspaces[0].has_tokens, true);
      assert.equal(body.workspaces[0].auth_test_status, "ok");
      assert.equal(body.workspaces[0].last_seen_at, 1740000000000);
    });
  });
});
