import { vi, type Mock } from "vitest";

export type SummaryDraft = {
  date: string;
  content: string;
  updatedAt: string;
  assistantMessage?: string | null;
  reasoning?: string | null;
};

export type SummaryEditorApiStubs = {
  loadSummary: Mock<(date: string) => Promise<{ content: string; exists: boolean }>>;
  saveSummary: Mock<
    (payload: { date: string; content: string }) => Promise<{ ok: boolean; savedAt: string }>
  >;
  requestSuggestion: Mock<
    (payload: {
      model: string;
      content: string;
      prompt?: string;
      date: string;
      previousResponseId?: string | null;
      selection?: unknown;
    }) => Promise<{
      summaryUpdate: { mode: "append" | "replace" | "none"; content: string };
      assistantMessage: string;
      reasoning: string | null;
      responseId: string | null;
    }>
  >;
};

export function createSummaryDraft(overrides: Partial<SummaryDraft> = {}): SummaryDraft {
  const now = new Date().toISOString();
  return {
    date: "2025-11-03",
    content: "## ダミーサマリ\n- 最初のエントリ",
    updatedAt: now,
    assistantMessage: null,
    reasoning: null,
    ...overrides,
  };
}

export function createSummaryEditorApiStubs(
  overrides: Partial<SummaryEditorApiStubs> = {}
): SummaryEditorApiStubs {
  const loadSummary =
    overrides.loadSummary ??
    vi.fn().mockResolvedValue({
      content: "",
      exists: false,
    });
  const saveSummary =
    overrides.saveSummary ??
    vi.fn().mockResolvedValue({
      ok: true,
      savedAt: new Date().toISOString(),
    });
  const requestSuggestion =
    overrides.requestSuggestion ??
    vi.fn().mockResolvedValue({
      summaryUpdate: { mode: "none", content: "" },
      assistantMessage: "[mock] suggestion",
      reasoning: null,
      responseId: "mock-response",
    });

  return {
    loadSummary,
    saveSummary,
    requestSuggestion,
  };
}
