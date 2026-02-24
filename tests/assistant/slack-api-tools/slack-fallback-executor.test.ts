import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SlackFallbackExecutor,
  SlackRouteError,
  type SlackMode,
  type WorkspaceRoutePin,
} from "../../../src/assistant/slack-api-tools/index.js";

type InMemoryStore = {
  map: Map<string, WorkspaceRoutePin>;
  get: (workspaceKey: string) => Promise<WorkspaceRoutePin | null>;
  set: (pin: WorkspaceRoutePin) => Promise<void>;
};

function createStore(): InMemoryStore {
  const map = new Map<string, WorkspaceRoutePin>();
  return {
    map,
    get: async (workspaceKey: string) => map.get(workspaceKey) ?? null,
    set: async (pin: WorkspaceRoutePin) => {
      map.set(pin.workspaceKey, pin);
    },
  };
}

describe("SlackFallbackExecutor", () => {
  it("auto_probe で primary が not_supported の場合は 1 回だけ fallback する", async () => {
    const store = createStore();
    const executor = new SlackFallbackExecutor({
      routeStore: store,
      now: () => 1_700_000_000_000,
    });

    const called: SlackMode[] = [];
    const result = await executor.runWithFallback({
      routingMode: "auto_probe",
      workspaceKey: "T123",
      operationName: "search_messages",
      probeMode: async () => "team",
      execute: async (mode) => {
        called.push(mode);
        if (mode === "team") {
          throw new SlackRouteError({
            kind: "not_supported",
            mode,
            message: "not allowed",
            slackError: "not_allowed_token_type",
          });
        }
        return { messages: [{ channelId: "C1", ts: "1" }] };
      },
    });

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.data.modeUsed, "enterprise");
    assert.equal(result.data.fallbackTried, true);
    assert.equal(called.join(","), "team,enterprise");
    assert.equal(store.map.get("T123")?.mode, "enterprise");
  });

  it("429 は fallback せず rate_limited を返す", async () => {
    const store = createStore();
    const executor = new SlackFallbackExecutor({ routeStore: store });

    const called: SlackMode[] = [];
    const result = await executor.runWithFallback({
      routingMode: "auto_probe",
      workspaceKey: "T123",
      operationName: "search_messages",
      probeMode: async () => "team",
      execute: async (mode) => {
        called.push(mode);
        throw new SlackRouteError({
          kind: "rate_limited",
          mode,
          message: "too many requests",
          slackError: "ratelimited",
        });
      },
    });

    assert.deepEqual(called, ["team"]);
    assert.deepEqual(result, {
      ok: false,
      code: "rate_limited",
      message: "search_messages is rate limited",
      primaryError: "team:rate_limited:ratelimited",
      fallbackError: undefined,
    });
  });

  it("manual_enterprise は enterprise のみ実行する", async () => {
    const store = createStore();
    const executor = new SlackFallbackExecutor({ routeStore: store });

    const called: SlackMode[] = [];
    const result = await executor.runWithFallback({
      routingMode: "manual_enterprise",
      workspaceKey: "T123",
      operationName: "post_message",
      probeMode: async () => "team",
      execute: async (mode) => {
        called.push(mode);
        return { channelId: "C1", ts: "123.456" };
      },
    });

    assert.deepEqual(called, ["enterprise"]);
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.data.modeUsed, "enterprise");
    assert.equal(result.data.fallbackTried, false);
  });
});
