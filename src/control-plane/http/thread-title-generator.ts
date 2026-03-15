import OpenAI from "openai";

const DEFAULT_THREAD_TITLE_MODEL = "gpt-5-nano";
const DEFAULT_THREAD_TITLE_TIMEOUT_MS = 5_000;

export type GenerateThreadTitleInput = {
  messages: string[];
};

export type GenerateThreadTitleResult = {
  title: string;
  model: string;
  fallback: boolean;
};

type ResponsesClient = {
  create: (input: {
    model: string;
    input: Array<{
      role: "developer" | "user";
      content: string;
    }>;
  }) => Promise<{
    output_text?: string;
  }>;
};

export interface ThreadTitleGeneratorOptions {
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  client?: ResponsesClient;
}

export type ThreadTitleGenerator = (
  input: GenerateThreadTitleInput
) => Promise<GenerateThreadTitleResult>;

export function createThreadTitleGenerator(
  options: ThreadTitleGeneratorOptions = {}
): ThreadTitleGenerator {
  const model = options.model?.trim() || DEFAULT_THREAD_TITLE_MODEL;
  const apiKey = options.apiKey?.trim();
  const timeoutMs = options.timeoutMs ?? DEFAULT_THREAD_TITLE_TIMEOUT_MS;
  const client =
    options.client ??
    (apiKey
      ? new OpenAI({
          apiKey,
          timeout: timeoutMs,
          maxRetries: 1,
        }).responses
      : undefined);

  return async (input) => {
    const sanitizedMessages = sanitizeMessages(input.messages);
    const fallbackTitle = buildFallbackThreadTitle(sanitizedMessages);
    if (sanitizedMessages.length === 0) {
      return {
        title: fallbackTitle,
        model,
        fallback: true,
      };
    }
    if (client === undefined) {
      return {
        title: fallbackTitle,
        model,
        fallback: true,
      };
    }

    try {
      const response = await client.create({
        model,
        input: [
          {
            role: "developer",
            content:
              "Generate a concise chat thread title in the same language as the user. " +
              "Return plain text only. No quotes, no markdown, no emoji, no trailing punctuation. " +
              "Prefer 4 to 10 words.",
          },
          {
            role: "user",
            content: buildTitlePrompt(sanitizedMessages),
          },
        ],
      });
      const title = normalizeGeneratedTitle(response.output_text ?? "", fallbackTitle);
      return {
        title,
        model,
        fallback: title === fallbackTitle,
      };
    } catch {
      return {
        title: fallbackTitle,
        model,
        fallback: true,
      };
    }
  };
}

function sanitizeMessages(messages: string[]): string[] {
  return messages
    .map((message) => message.replace(/\s+/g, " ").trim())
    .filter((message) => message.length > 0)
    .slice(0, 6)
    .map((message) => message.slice(0, 500));
}

function buildTitlePrompt(messages: string[]): string {
  return [
    "Conversation excerpts:",
    ...messages.map((message, index) => `${index + 1}. ${message}`),
    "",
    "Respond with the title only.",
  ].join("\n");
}

function normalizeGeneratedTitle(raw: string, fallbackTitle: string): string {
  const normalized = raw
    .replace(/\r/g, " ")
    .replace(/\n+/g, " ")
    .replace(/^["'「『]+/, "")
    .replace(/["'」』]+$/, "")
    .replace(/[。.!?]+$/u, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return normalized.length > 0 ? normalized : fallbackTitle;
}

function buildFallbackThreadTitle(messages: string[]): string {
  const first = messages[0] ?? "";
  return first.slice(0, 40).trim();
}
