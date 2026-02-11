import OpenAI from "openai";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

import { POST } from "../+server";

const createResponseMock = vi.fn();

vi.mock("$env/static/private", () => ({
  OPENAI_API_KEY: "test-key",
}));

vi.mock("$lib/server/openai", () => ({
  createOpenAIClient: () =>
    Promise.resolve({
      responses: {
        create: createResponseMock,
      },
    } as unknown as OpenAI),
}));

describe("POST /api/summary/suggestion", () => {
  beforeEach(() => {
    createResponseMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("structured outputs を利用してサマリ更新内容とアシスタント応答を返す", async () => {
    createResponseMock.mockResolvedValue({
      id: "resp-001",
      output: [
        {
          content: [
            {
              type: "output_text",
              text: JSON.stringify({
                summary_update: {
                  mode: "append",
                  content: "## Advice\n- item",
                },
                assistant_message: "ここがポイントです",
                reasoning: "analysis",
              }),
            },
          ],
        },
      ],
    });

    const request = new Request("http://example.test/api/summary/suggestion", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        prompt: "改善点を提案してください",
        content: "# Summary",
        date: "2025-11-03",
        selection: {
          start: 0,
          end: 8,
          content: "# Summary",
        },
      }),
    });

    const response = await POST({
      request,
      locals: {},
      fetch: fetch,
      params: {},
      url: new URL(request.url),
      setHeaders: vi.fn(),
    } as never);

    expect(response.status).toBe(200);
    const payload = await response.json();

    expect(payload).toEqual({
      summaryUpdate: { mode: "append", content: "## Advice\n- item" },
      assistantMessage: "ここがポイントです",
      reasoning: "analysis",
      responseId: "resp-001",
    });

    expect(createResponseMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-4.1-mini",
        text: expect.objectContaining({
          format: expect.objectContaining({
            type: "json_schema",
            name: "SummarySuggestion",
          }),
        }),
        instructions: expect.stringContaining(
          "あなたは日報の Markdown サマリを共同編集するアシスタントです。"
        ),
      })
    );

    const userPromptText = readUserPromptText(createResponseMock.mock.calls[0][0]?.input);
    expect(userPromptText).toContain("# Summary Request");
    expect(userPromptText).toContain("対象日: 2025-11-03");
    expect(userPromptText).toContain("## 選択中のサマリ");
    expect(userPromptText).toContain("# Summary");
  });

  it("リクエストパラメータが不足している場合は 400 を返す", async () => {
    const request = new Request("http://example.test/api/summary/suggestion", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "",
        prompt: "",
        content: "",
      }),
    });

    const response = await POST({
      request,
      locals: {},
      fetch: fetch,
      params: {},
      url: new URL(request.url),
      setHeaders: vi.fn(),
    } as never);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "model と prompt は必須です。",
    });
  });

  it("サマリ本文が空でも提案生成を行える", async () => {
    createResponseMock.mockResolvedValue({
      id: "resp-empty",
      output: [
        {
          content: [
            {
              type: "output_text",
              text: JSON.stringify({
                summary_update: {
                  mode: "append",
                  content: "### 新規追加\n- 項目",
                },
                assistant_message: "空のサマリに追記しました",
                reasoning: "ベーステキストが空だったため、冒頭に挿入しました。",
              }),
            },
          ],
        },
      ],
    });

    const request = new Request("http://example.test/api/summary/suggestion", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        prompt: "新しいセクションを作成してください",
        content: "",
        date: "2025-11-03",
      }),
    });

    const response = await POST({
      request,
      locals: {},
      fetch,
      params: {},
      url: new URL(request.url),
      setHeaders: vi.fn(),
    } as never);

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toEqual({
      summaryUpdate: { mode: "append", content: "### 新規追加\n- 項目" },
      assistantMessage: "空のサマリに追記しました",
      reasoning: "ベーステキストが空だったため、冒頭に挿入しました。",
      responseId: "resp-empty",
    });
  });

  it("previousResponseId を指定すると previous_response_id を API に渡す", async () => {
    createResponseMock.mockResolvedValue({
      id: "resp-002",
      output: [
        {
          content: [
            {
              type: "output_text",
              text: JSON.stringify({
                summary_update: {
                  mode: "none",
                  content: "",
                },
                assistant_message: "no change",
                reasoning: null,
              }),
            },
          ],
        },
      ],
    });

    const request = new Request("http://example.test/api/summary/suggestion", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        prompt: "続き",
        content: "# Summary",
        previousResponseId: "resp-001",
      }),
    });

    await POST({
      request,
      locals: {},
      fetch,
      params: {},
      url: new URL(request.url),
      setHeaders: vi.fn(),
    } as never);

    expect(createResponseMock).toHaveBeenCalledWith(
      expect.objectContaining({
        previous_response_id: "resp-001",
      })
    );
  });
});

type StructuredInputEntry = {
  role?: unknown;
  content?: unknown;
};

type StructuredInputChunk = {
  text?: unknown;
};

function readUserPromptText(input: unknown): string {
  if (!Array.isArray(input)) {
    return "";
  }

  const userEntry = input.find((entry): entry is StructuredInputEntry =>
    Boolean(entry && typeof entry === "object" && (entry as StructuredInputEntry).role === "user")
  );
  if (!userEntry) {
    return "";
  }

  const contents = userEntry.content;
  if (!Array.isArray(contents)) {
    return "";
  }

  const chunk = contents.find((item): item is StructuredInputChunk =>
    Boolean(item && typeof item === "object" && "text" in (item as Record<string, unknown>))
  );

  const text = chunk?.text;
  return typeof text === "string" ? text : "";
}
