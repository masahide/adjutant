import { z } from "zod";
import { zodTextFormat } from "openai/helpers/zod";

export type SummaryUpdateMode = "replace" | "append" | "none";

export type SummarySuggestionResult = {
  summaryUpdate: {
    mode: SummaryUpdateMode;
    content: string;
  };
  assistantMessage: string;
  reasoning: string | null;
};

const SummarySuggestionRawSchema = z.object({
  summary_update: z.object({
    mode: z.enum(["replace", "append", "none"]),
    content: z.string(),
  }),
  assistant_message: z.string().min(1, "assistant_message が空です。"),
  reasoning: z.union([z.string(), z.null()]),
});

export function buildSummarySuggestionResponseFormat() {
  return zodTextFormat(SummarySuggestionRawSchema, "SummarySuggestion");
}

export function parseSummarySuggestionText(text: string): SummarySuggestionResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error("LLM からの応答が JSON ではありません。", { cause: error });
  }

  const normalized = SummarySuggestionRawSchema.parse(parsed);
  const content = normalized.summary_update.content ?? "";
  const reasoningRaw = normalized.reasoning;
  const reasoning = reasoningRaw && reasoningRaw.trim().length > 0 ? reasoningRaw.trim() : null;

  return {
    summaryUpdate: {
      mode: normalized.summary_update.mode,
      content,
    },
    assistantMessage: normalized.assistant_message,
    reasoning,
  };
}
