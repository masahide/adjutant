import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { ToolHub } from "./hub.js";

export function createToolHubToolDefinition(toolHub: ToolHub): ToolDefinition {
  return {
    name: "tool_hub",
    label: "Tool Hub",
    description:
      "Single entrypoint for provider/action discovery and execution. Use no args for providers, provider only for actions, provider+action for help, provider+action+args to execute.",
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
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  };
}
