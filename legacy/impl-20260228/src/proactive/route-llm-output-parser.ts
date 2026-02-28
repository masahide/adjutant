import {
  normalizeRouteClassifierDecision,
  type RouteClassifierDecision,
} from "./route-classifier-decision.js";

type OpenAiToolCallLike = {
  function?: {
    arguments?: string | null;
  };
};

type OpenAiMessageLike = {
  content?: string | null;
  tool_calls?: OpenAiToolCallLike[];
};

export type OpenAiRouteCompletionLike = {
  choices?: Array<{
    message?: OpenAiMessageLike;
  }>;
};

function stripCodeFence(content: string): string {
  const trimmed = content.trim();
  if (!trimmed.startsWith("```")) {
    return trimmed;
  }
  return trimmed
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
}

function parseDecisionJson(rawJson: string): RouteClassifierDecision {
  const normalizedContent = stripCodeFence(rawJson);
  let parsed: unknown;
  try {
    parsed = JSON.parse(normalizedContent);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`route-llm-invalid-json: ${reason}`);
  }
  return normalizeRouteClassifierDecision(parsed);
}

function parseDecisionFromMessage(message: OpenAiMessageLike | undefined): RouteClassifierDecision {
  if (!message) {
    throw new Error("route-llm-empty-response");
  }

  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const call of toolCalls) {
    const args = call?.function?.arguments;
    if (typeof args !== "string") {
      continue;
    }
    return parseDecisionJson(args);
  }

  const content = message.content;
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new Error("route-llm-empty-response");
  }

  return parseDecisionJson(content);
}

export function parseRouteDecisionFromOpenAiCompletion(
  completion: OpenAiRouteCompletionLike
): RouteClassifierDecision {
  const message = completion.choices?.[0]?.message;
  return parseDecisionFromMessage(message);
}
