import type { ExternalThreadMessage } from "@assistant-ui/react";
import type { RuntimeMessage } from "./runtime.js";

export function toExternalMessages(
  messages: RuntimeMessage[],
  isStreaming: boolean
): ExternalThreadMessage[] {
  return messages.map((msg, i) => {
    const isLastAssistant = msg.role === "assistant" && i === messages.length - 1;

    const base = {
      id: `msg-${i}`,
      createdAt: new Date(msg.timestamp),
    } as const;

    if (msg.role === "user") {
      return {
        ...base,
        role: "user" as const,
        content: [{ type: "text" as const, text: msg.content }],
        attachments: [],
        metadata: { custom: {} },
      };
    }

    return {
      ...base,
      role: "assistant" as const,
      content: [{ type: "text" as const, text: msg.content }],
      status:
        isLastAssistant && isStreaming
          ? ({ type: "running" } as const)
          : ({ type: "complete", reason: "stop" } as const),
      metadata: {
        unstable_state: {},
        unstable_annotations: [],
        unstable_data: [],
        steps: [],
        custom: {},
      },
    };
  });
}
