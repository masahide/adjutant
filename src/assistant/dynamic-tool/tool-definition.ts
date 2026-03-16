import type { ToolDefinition } from "@mariozechner/pi-coding-agent";

import type { ToolHub } from "./hub.js";

export function createToolHubToolDefinition(toolHub: ToolHub): ToolDefinition {
  return {
    name: "tool_hub",
    label: "Tool Hub",
    description:
      "Additional tools are discoverable through tool_hub. If file search does not find what you need, or the task may require searching an external service such as Slack, inspect tool_hub first. Call tool_hub with no arguments to inspect the provider catalog, then call it again with the provider/action you want to use.",
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
