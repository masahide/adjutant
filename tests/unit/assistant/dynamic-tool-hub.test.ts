import assert from "node:assert/strict";
import test from "node:test";

import {
  ProviderRegistry,
  ToolHub,
  type DynamicProvider,
} from "../../../src/assistant/dynamic-tool/index.js";

function buildRegistry(): ProviderRegistry {
  const provider: DynamicProvider = {
    name: "demo",
    description: "demo provider",
    listActions: () => [
      {
        name: "echo",
        description: "echoes the input",
        requiredArgs: ["value"],
        argsSchema: {
          type: "object",
          properties: {
            value: { type: "string" },
          },
          required: ["value"],
          additionalProperties: false,
        },
      },
    ],
    getAction: (name) =>
      name === "echo"
        ? {
            descriptor: {
              name: "echo",
              description: "echoes the input",
              requiredArgs: ["value"],
            },
            validate: (args) => {
              if (typeof args.value !== "string" || args.value.trim().length === 0) {
                throw new Error("value required");
              }
            },
            execute: async (args) => ({ echoed: args.value }),
          }
        : undefined,
  };
  return new ProviderRegistry([provider]);
}

test("ToolHub returns catalog, help, execute, and unknown provider errors", async () => {
  const hub = new ToolHub(buildRegistry());

  assert.deepEqual(await hub.execute(), {
    ok: true,
    mode: "catalog",
    data: {
      providers: [{ name: "demo", description: "demo provider" }],
      usage: "set provider to get actions",
    },
  });

  assert.deepEqual(await hub.execute({ provider: "demo" }), {
    ok: true,
    mode: "provider_help",
    provider: "demo",
    data: {
      actions: [
        {
          name: "echo",
          description: "echoes the input",
          requiredArgs: ["value"],
          argsSchema: {
            type: "object",
            properties: {
              value: { type: "string" },
            },
            required: ["value"],
            additionalProperties: false,
          },
        },
      ],
    },
  });

  assert.deepEqual(await hub.execute({ provider: "demo", action: "echo" }), {
    ok: true,
    mode: "action_help",
    provider: "demo",
    action: "echo",
    data: {
      name: "echo",
      description: "echoes the input",
      requiredArgs: ["value"],
      argsSchema: { type: "object" },
    },
  });

  assert.deepEqual(await hub.execute({ provider: "demo", action: "echo", args: { value: "ok" } }), {
    ok: true,
    mode: "execute",
    provider: "demo",
    action: "echo",
    data: {
      echoed: "ok",
    },
  });

  assert.deepEqual(await hub.execute({ provider: "missing" }), {
    ok: false,
    code: "unknown_provider",
    provider: "missing",
    message: "unknown provider: missing",
  });
});
