import type { ToolDefinition } from "@mariozechner/pi-coding-agent";

import type { ToolHub } from "./hub.js";

export function createToolHubToolDefinition(toolHub: ToolHub): ToolDefinition {
  return {
    name: "tool_hub",
    label: "Tool Hub",
    description:
      "Single entrypoint for discovering and using custom tools. If you think a specialized integration may exist but do not see a direct tool, start with tool_hub. Use no args to list providers, provider only to list actions, provider+action for help, and provider+action+args to execute.",
    parameters: {
      type: "object",
      properties: {
        provider: { type: "string", minLength: 1 },
        action: { type: "string", minLength: 1 },
        args: { type: "object" },
      },
      additionalProperties: false,
    } as never,
    execute: async (_toolCallId, params) => {
      const result = await toolHub.execute(params);
      if (!result.ok) {
        throw new Error(result.message);
      }
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  };
}
