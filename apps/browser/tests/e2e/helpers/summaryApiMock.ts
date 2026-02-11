import { vi } from "vitest";

import type { SummaryDraftPayload } from "$lib/client/summary/api";
import type {
  SummaryChatRequest,
  SummarySuggestionResponse,
  SummaryChatSelection,
} from "$lib/client/summary/chat";

type JsonResponse<T> = {
  status: number;
  body?: T;
};

type SaveRequest = {
  content: string;
};

export type SummaryApiMock = {
  reset(): void;
  restore(): void;
  getLoadCount(): number;
  getInitializeCount(): number;
  getSavedPayloads(): SaveRequest[];
  getSuggestionRequests(): SummaryChatRequest[];
  setLoadResponse(response: JsonResponse<SummaryDraftPayload>): void;
  setInitializeResponse(response: JsonResponse<SummaryDraftPayload>): void;
  setSaveResponse(response: JsonResponse<{ savedAt: string }>): void;
  setSuggestionResponse(response: JsonResponse<SummarySuggestionResponse>): void;
};

export function createSummaryApiMock(date: string): SummaryApiMock {
  const originalFetch = globalThis.fetch;

  let loadResponse: JsonResponse<SummaryDraftPayload> = {
    status: 200,
    body: { content: "", exists: false },
  };
  let initializeResponse: JsonResponse<SummaryDraftPayload> = {
    status: 201,
    body: { content: "", exists: false },
  };
  let saveResponse: JsonResponse<{ savedAt: string }> = {
    status: 200,
    body: { savedAt: new Date().toISOString() },
  };
  let suggestionResponse: JsonResponse<SummarySuggestionResponse> = {
    status: 200,
    body: {
      summaryUpdate: { mode: "none", content: "" },
      assistantMessage: "[mock] assistant message",
      reasoning: null,
      responseId: "mock-response",
    },
  };

  let loadCount = 0;
  let initializeCount = 0;
  const saveRequests: SaveRequest[] = [];
  const suggestionRequests: SummaryChatRequest[] = [];

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const { url, method } = normalizeFetchArguments(input, init);

    if (url.pathname === `/day/${date}/summary`) {
      if (method === "GET") {
        loadCount += 1;
        return buildResponse(loadResponse);
      }
      if (method === "POST") {
        initializeCount += 1;
        return buildResponse(initializeResponse);
      }
      if (method === "PUT") {
        const payload = await parseJson(init?.body);
        if (payload && typeof payload.content === "string") {
          saveRequests.push({ content: payload.content });
        }
        return buildResponse(saveResponse);
      }
    }

    if (url.pathname === "/api/summary/suggestion" && method === "POST") {
      const payload = await parseJson(init?.body);
      suggestionRequests.push({
        model: readString(payload, "model"),
        prompt: readString(payload, "prompt"),
        content: readString(payload, "content"),
        date: readOptionalString(payload, "date") ?? "",
        previousResponseId: readOptionalString(payload, "previousResponseId"),
        selection: parseSelection(payload.selection),
      });
      return buildResponse(suggestionResponse);
    }

    // 未モックのリクエストは 404 を返す
    return new Response(null, { status: 404 });
  });

  globalThis.fetch = fetchMock as typeof fetch;

  return {
    reset() {
      loadCount = 0;
      initializeCount = 0;
      saveRequests.length = 0;
      suggestionRequests.length = 0;
      fetchMock.mockClear();
    },
    restore() {
      globalThis.fetch = originalFetch;
    },
    getLoadCount() {
      return loadCount;
    },
    getInitializeCount() {
      return initializeCount;
    },
    getSavedPayloads() {
      return [...saveRequests];
    },
    getSuggestionRequests() {
      return [...suggestionRequests];
    },
    setLoadResponse(response: JsonResponse<SummaryDraftPayload>) {
      loadResponse = response;
    },
    setInitializeResponse(response: JsonResponse<SummaryDraftPayload>) {
      initializeResponse = response;
    },
    setSaveResponse(response: JsonResponse<{ savedAt: string }>) {
      saveResponse = response;
    },
    setSuggestionResponse(response: JsonResponse<SummarySuggestionResponse>) {
      suggestionResponse = response;
    },
  };
}

function normalizeFetchArguments(input: RequestInfo | URL, init?: RequestInit) {
  if (input instanceof Request) {
    return {
      url: new URL(input.url),
      method: input.method.toUpperCase(),
    };
  }
  if (input instanceof URL) {
    return {
      url: input,
      method: (init?.method ?? "GET").toUpperCase(),
    };
  }
  const url = new URL(input, "http://localhost");
  const method = (init?.method ?? "GET").toUpperCase();
  return { url, method };
}

async function parseJson(body: BodyInit | null | undefined): Promise<Record<string, unknown>> {
  if (!body) {
    return {};
  }
  if (typeof body === "string") {
    try {
      return JSON.parse(body) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  if (body instanceof Uint8Array) {
    try {
      return JSON.parse(Buffer.from(body).toString("utf-8")) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  if (typeof body === "object" && "getReader" in body && typeof body.getReader === "function") {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        chunks.push(value);
      }
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return {};
}

function readString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === "string" ? value : "";
}

function readOptionalString(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  return typeof value === "string" ? value : null;
}

function parseSelection(raw: unknown): SummaryChatSelection | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const start = readNumber(record, "start");
  const end = readNumber(record, "end");
  if (start === null || end === null) {
    return undefined;
  }
  const content = readString(record, "content");
  if (end <= start) {
    return undefined;
  }
  return {
    start,
    end,
    content,
  };
}

function readNumber(input: Record<string, unknown>, key: string): number | null {
  const value = input[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function buildResponse<T>(response: JsonResponse<T>): Response {
  const { status, body } = response;
  if (typeof body === "undefined") {
    return new Response(null, { status });
  }
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
