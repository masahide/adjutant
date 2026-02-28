import type { SessionTranscriptEvent } from "./types.js";

export function normalizeTranscriptRole(value: unknown): SessionTranscriptEvent["role"] {
  if (typeof value !== "string") {
    return "other";
  }
  switch (value.trim().toLowerCase()) {
    case "user":
      return "user";
    case "assistant":
      return "assistant";
    case "system":
      return "system";
    case "tool":
      return "tool";
    default:
      return "other";
  }
}

export function extractTranscriptMessageText(message: Record<string, unknown>): string | undefined {
  const content = message.content;
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed ? trimmed : undefined;
  }

  if (Array.isArray(content)) {
    const texts = content
      .map((item) => {
        if (!item || typeof item !== "object") {
          return "";
        }
        const text = (item as Record<string, unknown>).text;
        return typeof text === "string" ? text.trim() : "";
      })
      .filter(Boolean);
    if (texts.length > 0) {
      return texts.join("\n");
    }
  }

  const text = message.text;
  if (typeof text === "string") {
    const trimmed = text.trim();
    return trimmed ? trimmed : undefined;
  }
  return undefined;
}
