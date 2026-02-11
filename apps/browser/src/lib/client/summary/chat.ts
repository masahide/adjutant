export type SummaryChatSelection = {
  start: number;
  end: number;
  content: string;
};

export type SummaryChatRequest = {
  model: string;
  prompt: string;
  content: string;
  date: string;
  previousResponseId?: string | null;
  selection?: SummaryChatSelection | null;
};

export type SummaryUpdateMode = "replace" | "append" | "none";

export type SummarySuggestionResponse = {
  summaryUpdate: {
    mode: SummaryUpdateMode;
    content: string;
  };
  assistantMessage: string;
  reasoning: string | null;
  responseId: string | null;
};

export async function requestSuggestion(
  input: SummaryChatRequest,
  fetchImpl: typeof fetch = fetch
): Promise<SummarySuggestionResponse> {
  const response = await fetchImpl("/api/summary/suggestion", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error(`Failed to request suggestion: ${response.status}`);
  }
  const payload = await response.json();
  return normalizeSuggestion(payload);
}

function normalizeSuggestion(raw: unknown): SummarySuggestionResponse {
  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid summary suggestion response.");
  }
  const data = raw as Record<string, unknown>;
  const summaryUpdateRaw = data.summaryUpdate;
  if (!summaryUpdateRaw || typeof summaryUpdateRaw !== "object") {
    throw new Error("summaryUpdate field is missing.");
  }
  const summaryUpdateRecord = summaryUpdateRaw as Record<string, unknown>;
  const mode = summaryUpdateRecord.mode;
  if (mode !== "replace" && mode !== "append" && mode !== "none") {
    throw new Error("summaryUpdate.mode is invalid.");
  }
  const content =
    typeof summaryUpdateRecord.content === "string" ? summaryUpdateRecord.content : "";
  const assistantMessage = typeof data.assistantMessage === "string" ? data.assistantMessage : "";
  if (!assistantMessage) {
    throw new Error("assistantMessage is empty.");
  }
  const reasoning =
    typeof data.reasoning === "string" && data.reasoning.trim().length > 0 ? data.reasoning : null;
  const responseId =
    typeof data.responseId === "string" && data.responseId.trim().length > 0
      ? data.responseId
      : null;

  return {
    summaryUpdate: {
      mode,
      content,
    },
    assistantMessage,
    reasoning,
    responseId,
  };
}
