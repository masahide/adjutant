export type SummaryEditorDraft = {
  date: string;
  content: string;
  updatedAt?: string;
  assistantMessage?: string | null;
  reasoning?: string | null;
};

export type SummaryWorkspaceEvents = {
  modelchange: { model: string };
  promptsubmit: { prompt: string; model: string };
  draftinput: { content: string };
  draftsave: { content: string };
  draftcreate: { date: string };
  assistantdismiss: Record<string, never>;
};

export type SummaryUpdate = {
  mode: "replace" | "append" | "none";
  content: string;
};

export type SummarySuggestionPayload = {
  summaryUpdate: SummaryUpdate;
  assistantMessage: string;
  reasoning: string | null;
  responseId: string | null;
};
