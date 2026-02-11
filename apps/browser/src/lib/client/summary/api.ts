export type SummaryDraftPayload = {
  content: string;
  exists: boolean;
  updatedAt?: string;
  assistantMessage?: string | null;
  reasoning?: string | null;
};

const DEFAULT_HEADERS = {
  Accept: "application/json",
};

export async function loadSummaryDraft(
  date: string,
  fetchImpl: typeof fetch = fetch
): Promise<SummaryDraftPayload> {
  const response = await fetchImpl(`/day/${date}/summary`, {
    method: "GET",
    headers: DEFAULT_HEADERS,
  });
  if (!response.ok) {
    throw new Error(`Failed to load summary: ${response.status}`);
  }
  return normalize(await response.json());
}

export async function initializeSummaryDraft(
  date: string,
  fetchImpl: typeof fetch = fetch
): Promise<SummaryDraftPayload> {
  const response = await fetchImpl(`/day/${date}/summary`, {
    method: "POST",
    headers: DEFAULT_HEADERS,
  });
  if (!response.ok) {
    throw new Error(`Failed to initialize summary: ${response.status}`);
  }
  return normalize(await response.json());
}

export function isSummaryEditMode(url: URL): boolean {
  return url.searchParams.get("summary") === "edit";
}

export function ensureSummaryEditUrl(url: URL): string {
  const params = new URLSearchParams(url.search);
  params.set("summary", "edit");
  const query = params.toString();
  return `${url.pathname}${query ? `?${query}` : ""}`;
}

function normalize(raw: unknown): SummaryDraftPayload {
  if (!raw || typeof raw !== "object") {
    return { content: "", exists: false };
  }
  const data = raw as Record<string, unknown>;
  const content = typeof data.content === "string" ? data.content : "";
  const exists = Boolean(data.exists);
  const updatedAt = typeof data.updatedAt === "string" ? data.updatedAt : undefined;
  const assistantMessage =
    typeof data.assistantMessage === "string" && data.assistantMessage.trim().length > 0
      ? data.assistantMessage
      : null;
  const reasoning =
    typeof data.reasoning === "string" && data.reasoning.trim().length > 0 ? data.reasoning : null;
  return { content, exists, updatedAt, assistantMessage, reasoning };
}

export async function saveSummaryDraft(
  date: string,
  payload: { content: string },
  fetchImpl: typeof fetch = fetch
): Promise<{ savedAt: string }> {
  const response = await fetchImpl(`/day/${date}/summary`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`Failed to save summary: ${response.status}`);
  }
  const body = (await response.json()) as { savedAt: string };
  return body;
}
