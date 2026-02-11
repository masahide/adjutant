import { json } from "@sveltejs/kit";
import { OPENAI_API_KEY } from "$env/static/private";

import type { RequestHandler } from "./$types";
import { resolveDataDir } from "$lib/server/config";
import {
  readDailyEvents,
  readDailySummary,
  readDailySummaryStats,
  writeDailySummary,
} from "$lib/server/data";
import { formatEventTime } from "$lib/format/date";
import {
  getEventChannelLabel,
  getEventPresentation,
  getReactionEmoji,
} from "$lib/presentation/event";
import type { TimelineEvent } from "$lib/server/types";
import { createOpenAIClient } from "$lib/server/openai";
import { loadLlmConfig } from "$lib/server/llmConfig";
import {
  buildSummarySuggestionResponseFormat,
  parseSummarySuggestionText,
} from "$lib/server/summarySuggestion";
import {
  loadSummaryPromptTemplates,
  renderSummaryUserPrompt,
  type SummaryPromptContext,
  type SummaryPromptEventContext,
} from "$lib/server/summaryPrompts";
import { applySummaryUpdate } from "$lib/summary/update";

type SummaryPayload = {
  content: string;
  exists: boolean;
  updatedAt: string | null;
  assistantMessage?: string | null;
  reasoning?: string | null;
};

const NO_STORE_HEADERS = {
  "cache-control": "no-store, max-age=0",
};

export const GET: RequestHandler = async ({ params }) => {
  const date = params.date;
  if (!date) {
    return json({ error: "date is required." }, { status: 400 });
  }

  const dataDir = resolveDataDir();
  const [content, stats] = await Promise.all([
    readDailySummary({ dataDir, date }),
    readDailySummaryStats(dataDir, date),
  ]);

  return json(buildSummaryPayload(content, stats.exists, stats.updatedAt), {
    status: 200,
    headers: NO_STORE_HEADERS,
  });
};

export const POST: RequestHandler = async ({ params }) => {
  const date = params.date;
  if (!date) {
    return json({ error: "date is required." }, { status: 400 });
  }

  const dataDir = resolveDataDir();
  const summary = await readDailySummary({ dataDir, date });
  const stats = await readDailySummaryStats(dataDir, date);

  const normalized = typeof summary === "string" ? summary : "";
  const hasExistingContent = normalized.trim().length > 0 && stats.exists;

  if (!hasExistingContent) {
    const { events } = await readDailyEvents({ dataDir, date });
    const generated = await generateSummaryWithPrompts({ dataDir, date, events });
    const content =
      generated?.content ??
      buildFallbackSummary({
        date,
        events,
      });
    const { savedAt } = await writeDailySummary({ dataDir, date, content });
    return json(
      buildSummaryPayload(
        content,
        true,
        savedAt,
        generated?.assistantMessage ?? null,
        generated?.reasoning ?? null
      ),
      {
        status: 200,
        headers: NO_STORE_HEADERS,
      }
    );
  }

  return json(buildSummaryPayload(normalized, true, stats.updatedAt), {
    status: 200,
    headers: NO_STORE_HEADERS,
  });
};

export const PUT: RequestHandler = async ({ params, request }) => {
  const date = params.date;
  if (!date) {
    return json({ error: "date is required." }, { status: 400 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "JSON body is required." }, { status: 400 });
  }

  if (
    !payload ||
    typeof payload !== "object" ||
    typeof (payload as { content?: unknown }).content !== "string"
  ) {
    return json({ error: "content field is required." }, { status: 400 });
  }

  const content = (payload as { content: string }).content;
  const dataDir = resolveDataDir();
  const { savedAt } = await writeDailySummary({ dataDir, date, content });

  return json(
    { savedAt },
    {
      status: 200,
      headers: NO_STORE_HEADERS,
    }
  );
};

function buildSummaryPayload(
  content: string | null,
  exists: boolean,
  updatedAt: string | null,
  assistantMessage: string | null = null,
  reasoning: string | null = null
): SummaryPayload {
  return {
    content: content ?? "",
    exists,
    updatedAt,
    assistantMessage,
    reasoning,
  };
}

const INITIAL_SUMMARY_PROMPT = "この日のイベントを参考に Markdown の日報サマリを作成してください。";

async function generateSummaryWithPrompts(options: {
  dataDir: string;
  date: string;
  events: TimelineEvent[];
}): Promise<{
  content: string | null;
  assistantMessage: string | null;
  reasoning: string | null;
} | null> {
  if (!OPENAI_API_KEY || OPENAI_API_KEY.trim().length === 0) {
    return null;
  }

  const templates = await loadSummaryPromptTemplates();
  const promptContext: SummaryPromptContext = {
    mode: "initial",
    date: options.date,
    prompt: INITIAL_SUMMARY_PROMPT,
    content: "",
    events: buildPromptEvents(options.date, options.events),
  };
  const userPrompt = renderSummaryUserPrompt(templates.user.source, promptContext);
  if (!userPrompt) {
    return null;
  }

  try {
    const client = await createOpenAIClient({ apiKey: OPENAI_API_KEY });
    const llmConfig = await loadLlmConfig();
    const model = llmConfig.defaultModel ?? llmConfig.models[0] ?? "gpt-4.1-mini";
    const response = await client.responses.create({
      model,
      text: {
        format: buildSummarySuggestionResponseFormat(),
      },
      instructions: templates.system.source,
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
    const content = stripAssistantMessage(
      applySummaryUpdate("", suggestion.summaryUpdate).trimEnd(),
      suggestion.assistantMessage
    );
    return {
      content: content.length > 0 ? content : null,
      assistantMessage: suggestion.assistantMessage ?? null,
      reasoning: suggestion.reasoning ?? null,
    };
  } catch (error) {
    console.error("summary generation via LLM failed", error);
    return null;
  }
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

function buildFallbackSummary(options: { date: string; events: TimelineEvent[] }): string {
  const { date, events } = options;
  const lines: string[] = [`# ReacLog 日報 ${date}`];

  const sections = buildSummarySections(date, events);
  if (sections.length === 0) {
    lines.push("", "## 本日のイベント", "- この日に記録されたイベントはまだありません。");
  } else {
    for (const section of sections) {
      lines.push("", `## ${section.label}`, ...section.entries);
    }
  }

  lines.push(
    "",
    "## TODO / ブロッカー",
    "- 追加で共有したい課題や懸念点があればここに追記してください。"
  );

  return lines.join("\n").trimEnd();
}

function buildPromptEvents(date: string, events: TimelineEvent[]): SummaryPromptEventContext[] {
  return events.map((event) => ({
    uid: event.uid,
    source: formatSourceHeading(event.source),
    channel: getEventChannelLabel(event),
    message: normalizeMessage(getEventPresentation(event).text),
    reaction: normalizeReactionLabel(getReactionEmoji(event)),
    time: formatEventTime(event.ts ?? null, date),
    timestamp: event.ts ?? null,
  }));
}

function stripAssistantMessage(
  content: string,
  assistantMessage: string | null | undefined
): string {
  if (!assistantMessage) {
    return content;
  }
  const trimmedAssistant = assistantMessage.trim();
  if (!trimmedAssistant) {
    return content;
  }

  const trimmedContent = content.trimEnd();
  if (trimmedContent === trimmedAssistant) {
    return "";
  }
  if (trimmedContent.endsWith(`\n${trimmedAssistant}`)) {
    const withoutMessage = trimmedContent.slice(0, trimmedContent.length - trimmedAssistant.length);
    return withoutMessage.trimEnd();
  }
  return content;
}

type SummarySection = {
  label: string;
  entries: string[];
};

function buildSummarySections(date: string, events: TimelineEvent[]): SummarySection[] {
  const sections: SummarySection[] = [];
  const lookup = new Map<string, SummarySection>();

  for (const event of events) {
    const label = formatSourceHeading(event.source);
    let section = lookup.get(label);
    if (!section) {
      section = { label, entries: [] };
      lookup.set(label, section);
      sections.push(section);
    }
    const line = formatEventLine(event, date);
    if (line) {
      section.entries.push(line);
    }
  }

  return sections;
}

function formatEventLine(event: TimelineEvent, date: string): string | null {
  const timeLabel = formatEventTime(event.ts ?? null, date);
  const channel = getEventChannelLabel(event);
  const presentation = getEventPresentation(event);
  const message = normalizeMessage(presentation.text);
  const reaction = getReactionEmoji(event);

  const details: string[] = [];
  if (channel) {
    details.push(channel);
  }
  if (message) {
    details.push(message);
  }
  const normalizedReaction = normalizeReactionLabel(reaction);
  if (normalizedReaction) {
    details.push(`リアクション ${normalizedReaction}`);
  }

  if (details.length === 0) {
    details.push(event.uid);
  }

  return `- ${timeLabel} ${details.join(" ")}`.trim();
}

function normalizeMessage(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(" / ");
}

function normalizeReactionLabel(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (/^:[^:]+:$/.test(trimmed)) {
    return trimmed;
  }
  if (/^[^:]+$/.test(trimmed)) {
    return `:${trimmed}:`;
  }
  return trimmed;
}

function formatSourceHeading(source: string): string {
  const trimmed = source.trim();
  if (!trimmed) {
    return "その他";
  }
  const normalized = trimmed.toLowerCase();
  const known: Record<string, string> = {
    slack: "Slack",
    github: "GitHub",
    notion: "Notion",
    manual: "Manual",
  };
  const label = known[normalized];
  if (label) {
    return label;
  }
  return trimmed[0].toUpperCase() + trimmed.slice(1);
}
