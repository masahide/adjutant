import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ProviderRegistry,
  ToolHub,
  type DynamicAction,
  type DynamicActionDescriptor,
  type DynamicProvider,
} from "../../../src/assistant/dynamic-tool/index.js";

function createFakeProvider(): DynamicProvider {
  const searchAction: DynamicAction = {
    descriptor: {
      name: "search_messages",
      description: "search slack messages",
      requiredArgs: ["query"],
      argsSchema: {
        type: "object",
        properties: { query: { type: "string", minLength: 1 } },
        required: ["query"],
      },
    },
    validate: (args) => {
      const query = args.query;
      if (typeof query !== "string" || query.trim().length === 0) {
        throw new Error("query required");
      }
    },
    execute: async (args) => ({
      query: args.query,
      count: 1,
    }),
  };

  const failAction: DynamicAction = {
    descriptor: {
      name: "fail_action",
      description: "always fails",
    },
    validate: () => undefined,
    execute: async () => {
      throw new Error("boom");
    },
  };

  const descriptors: DynamicActionDescriptor[] = [searchAction.descriptor, failAction.descriptor];
  const actionMap = new Map<string, DynamicAction>([
    ["search_messages", searchAction],
    ["fail_action", failAction],
  ]);

  return {
    name: "slack",
    description: "Slack tools",
    listActions: () => descriptors,
    getAction: (actionName: string) => actionMap.get(actionName.trim().toLowerCase()),
  };
}

describe("tool hub", () => {
  it("引数なしは catalog を返す", async () => {
    const hub = new ToolHub(new ProviderRegistry([createFakeProvider()]));
    const result = await hub.execute();
    assert.equal(result.ok, true);
    assert.equal(result.mode, "catalog");
    assert.deepEqual(result.data, {
      providers: [{ name: "slack", description: "Slack tools" }],
      usage: "set provider to get actions",
    });
  });

  it("provider 指定のみは provider_help を返す", async () => {
    const hub = new ToolHub(new ProviderRegistry([createFakeProvider()]));
    const result = await hub.execute({ provider: "  slack " });
    assert.equal(result.ok, true);
    assert.equal(result.mode, "provider_help");
    assert.equal(result.provider, "slack");
    assert.deepEqual(result.data, {
      actions: [
        {
          name: "search_messages",
          description: "search slack messages",
          requiredArgs: ["query"],
          argsSchema: {
            type: "object",
            properties: { query: { type: "string", minLength: 1 } },
            required: ["query"],
          },
        },
        {
          name: "fail_action",
          description: "always fails",
        },
      ],
    });
  });

  it("provider+action は action_help、args ありは execute を返す", async () => {
    const hub = new ToolHub(new ProviderRegistry([createFakeProvider()]));
    const help = await hub.execute({ provider: "slack", action: "search_messages" });
    assert.equal(help.ok, true);
    assert.equal(help.mode, "action_help");

    const execute = await hub.execute({
      provider: "slack",
      action: "search_messages",
      args: { query: "hello" },
    });
    assert.equal(execute.ok, true);
    assert.equal(execute.mode, "execute");
    assert.deepEqual(execute.data, { query: "hello", count: 1 });
  });

  it("未知 provider/action と validation/execution エラーを分類する", async () => {
    const hub = new ToolHub(new ProviderRegistry([createFakeProvider()]));

    const unknownProvider = await hub.execute({ provider: "unknown" });
    assert.deepEqual(unknownProvider, {
      ok: false,
      code: "unknown_provider",
      provider: "unknown",
      action: undefined,
      message: "unknown provider: unknown",
    });

    const unknownAction = await hub.execute({ provider: "slack", action: "unknown_action" });
    assert.deepEqual(unknownAction, {
      ok: false,
      code: "unknown_action",
      provider: "slack",
      action: "unknown_action",
      message: "unknown action: unknown_action",
    });

    const validationError = await hub.execute({
      provider: "slack",
      action: "search_messages",
      args: {},
    });
    assert.deepEqual(validationError, {
      ok: false,
      code: "validation_error",
      provider: "slack",
      action: "search_messages",
      message: "query required",
    });

    const executionError = await hub.execute({
      provider: "slack",
      action: "fail_action",
      args: {},
    });
    assert.deepEqual(executionError, {
      ok: false,
      code: "execution_error",
      provider: "slack",
      action: "fail_action",
      message: "boom",
    });
  });
});
