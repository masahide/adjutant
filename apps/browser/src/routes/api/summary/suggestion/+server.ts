import { json } from "@sveltejs/kit";
import { OPENAI_API_KEY } from "$env/static/private";

import type { RequestHandler } from "./$types";
import { createOpenAIClient } from "$lib/server/openai";
import {
  buildSummarySuggestionResponseFormat,
  parseSummarySuggestionText,
} from "$lib/server/summarySuggestion";
import {
  loadSummaryPromptTemplates,
  renderSummaryUserPrompt,
  type SummaryPromptContext,
} from "$lib/server/summaryPrompts";

type SuggestionRequestBody = {
  model?: unknown;
  prompt?: unknown;
  content?: unknown;
  date?: unknown;
  selection?: unknown;
  previousResponseId?: unknown;
};

type SummarySelection = {
  start: number;
  end: number;
  content: string;
} | null;

export const POST: RequestHandler = async ({ request }) => {
  const body = await readRequestBody(request);
  if (!body.ok) {
    return json({ error: body.error }, { status: 400 });
  }

  if (!OPENAI_API_KEY || OPENAI_API_KEY.trim().length === 0) {
    return json({ error: "OpenAI API キーが設定されていません。" }, { status: 503 });
  }

  try {
    const templates = await loadSummaryPromptTemplates();
    const promptContext: SummaryPromptContext = {
      mode: "chat",
      date: body.value.date,
      prompt: body.value.prompt,
      content: body.value.content,
      selection: body.value.selection,
    };
    const userPrompt = renderSummaryUserPrompt(templates.user.source, promptContext);

    const client = await createOpenAIClient({ apiKey: OPENAI_API_KEY });
    const response = await client.responses.create({
      model: body.value.model,
      text: {
        format: buildSummarySuggestionResponseFormat(),
      },
      instructions: templates.system.source,
      previous_response_id: body.value.previousResponseId ?? undefined,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: userPrompt,
            },
          ],
        },
      ],
    });

    const structuredText = extractStructuredText(response);
    const suggestion = parseSummarySuggestionText(structuredText);
    const responseId = readResponseId(response);

    return json(
      {
        summaryUpdate: suggestion.summaryUpdate,
        assistantMessage: suggestion.assistantMessage,
        reasoning: suggestion.reasoning,
        responseId,
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("summary suggestion failed", error);
    return json(
      { error: "サマリ提案の生成に失敗しました。" },
      {
        status: 502,
      }
    );
  }
};

async function readRequestBody(request: Request): Promise<
  | {
      ok: true;
      value: {
        model: string;
        prompt: string;
        content: string;
        date: string | null;
        selection: SummarySelection;
        previousResponseId: string | null;
      };
    }
  | { ok: false; error: string }
> {
  let payload: SuggestionRequestBody;
  try {
    payload = (await request.json()) as SuggestionRequestBody;
  } catch {
    return { ok: false, error: "JSON 形式でリクエストしてください。" };
  }

  const model = typeof payload.model === "string" ? payload.model.trim() : "";
  const prompt = typeof payload.prompt === "string" ? payload.prompt.trim() : "";
  const content = typeof payload.content === "string" ? payload.content : "";
  const date =
    typeof payload.date === "string" && payload.date.trim().length > 0 ? payload.date.trim() : null;
  const selection = normalizeSelection(payload.selection);
  const previousResponseId =
    typeof payload.previousResponseId === "string" && payload.previousResponseId.trim().length > 0
      ? payload.previousResponseId.trim()
      : null;

  if (!model || !prompt) {
    return { ok: false, error: "model と prompt は必須です。" };
  }

  return {
    ok: true,
    value: {
      model,
      prompt,
      content,
      date,
      selection,
      previousResponseId,
    },
  };
}

function extractStructuredText(response: unknown): string {
  if (!response || typeof response !== "object") {
    throw new Error("OpenAI 応答が空です。");
  }

  const output = (response as { output?: unknown }).output;
  if (!Array.isArray(output)) {
    throw new Error("OpenAI 応答に output が含まれていません。");
  }

  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const chunk of content) {
      if (chunk && typeof chunk === "object") {
        const type = (chunk as { type?: unknown }).type;
        const text = (chunk as { text?: unknown }).text;
        if (typeof text === "string" && (type === "output_text" || type === "text" || !type)) {
          return text;
        }
      }
    }
  }

  throw new Error("OpenAI 応答から structured output を抽出できませんでした。");
}

function readResponseId(response: unknown): string | null {
  if (!response || typeof response !== "object") {
    return null;
  }
  const rawId = (response as { id?: unknown }).id;
  if (typeof rawId === "string" && rawId.trim().length > 0) {
    return rawId;
  }
  return null;
}

function normalizeSelection(input: unknown): SummarySelection {
  if (!input || typeof input !== "object") {
    return null;
  }
  const record = input as Record<string, unknown>;
  const start = parseIndex(record.start);
  const end = parseIndex(record.end);
  if (start === null || end === null) {
    return null;
  }
  if (end <= start) {
    return null;
  }
  const content =
    typeof record.content === "string"
      ? record.content
      : Array.isArray(record.content)
        ? record.content.join("\n")
        : "";
  return {
    start,
    end,
    content,
  };
}

function parseIndex(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return null;
}
