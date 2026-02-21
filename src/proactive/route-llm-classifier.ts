import OpenAI from "openai";
import type { NormalizedEvent } from "../core/events.js";
import type { RouterOutcome } from "./route-decision.js";
import {
  normalizeRouteClassifierDecision,
  type RouteClassifierDecision,
} from "./route-classifier-decision.js";
import type { SecondaryClassifier } from "./trigger-filter.js";

const DEFAULT_ROUTE_LLM_MODEL = "gpt-5-mini";
const DEFAULT_ROUTE_LLM_TIMEOUT_MS = 1_000;
const DEFAULT_ROUTE_LLM_MAX_CONCURRENT = 1;
const DEFAULT_EVENT_TEXT_MAX_CHARS = 1_200;

type OpenAiChatCompletionClient = {
  chat: {
    completions: {
      create: (params: {
        model: string;
        temperature: number;
        response_format: { type: "json_object" };
        messages: Array<{ role: "system" | "user"; content: string }>;
      }) => Promise<{
        id?: string;
        choices?: Array<{
          message?: {
            content?: string | null;
          };
        }>;
      }>;
    };
  };
};

export type RouteLlmRuntimeConfig = {
  enabled: boolean;
  provider: "openai";
  model: string;
  routeLlmTimeoutMs: number;
  maxConcurrentRouteLlm: number;
};

export type RouteLlmAuditLog = {
  event: "route-llm-decision" | "route-llm-error";
  uid: string;
  eventKind: string;
  model: string;
  durationMs: number;
  outcome?: RouterOutcome;
  confidence?: number;
  reason?: string;
};

export type OpenAiSecondaryClassifierOptions = {
  model: string;
  apiKey?: string;
  maxConcurrent?: number;
  client?: OpenAiChatCompletionClient;
  maxEventTextChars?: number;
  onAudit?: (log: RouteLlmAuditLog) => void;
};

const ROUTE_SYSTEM_PROMPT = [
  "You are a lightweight classifier for proactive assistant routing.",
  'Return JSON only: {"outcome":"run"|"pending","confidence":0..1,"reason":"short"}',
  "Choose run when immediate assistant action is likely required.",
  "Choose pending for FYI updates, low-priority chatter, and non-actionable notifications.",
  "Do not add markdown fences or extra keys.",
].join(" ");

function parseBoolean(rawValue: string | undefined, fallback: boolean): boolean {
  if (!rawValue) {
    return fallback;
  }
  const normalized = rawValue.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    return false;
  }
  return fallback;
}

function parsePositiveInt(rawValue: string | undefined, fallback: number): number {
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

function parseString(rawValue: string | undefined, fallback: string): string {
  const value = rawValue?.trim();
  return value && value.length > 0 ? value : fallback;
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}...[truncated]`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as Record<string, unknown>;
}

function extractSlackDetail(event: NormalizedEvent): Record<string, unknown> | null {
  const detail = asRecord(event.detail);
  if (!detail) {
    return null;
  }
  return asRecord(detail.slack);
}

function extractEventText(event: NormalizedEvent): string | null {
  const slack = extractSlackDetail(event);
  if (!slack) {
    return null;
  }
  if (event.kind === "post") {
    const text = slack.text;
    if (typeof text === "string" && text.trim().length > 0) {
      return text.trim();
    }
  }
  if (event.kind === "notification") {
    const title = typeof slack.title === "string" ? slack.title.trim() : "";
    const messageText = typeof slack.message_text === "string" ? slack.message_text.trim() : "";
    const combined = [title, messageText].filter((value) => value.length > 0).join(" | ");
    if (combined.length > 0) {
      return combined;
    }
  }
  if (event.kind === "reaction") {
    const messageText = slack.message_text;
    if (typeof messageText === "string" && messageText.trim().length > 0) {
      return messageText.trim();
    }
  }
  return null;
}

function stripCodeFence(content: string): string {
  const trimmed = content.trim();
  if (!trimmed.startsWith("```")) {
    return trimmed;
  }
  return trimmed
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
}

function parseRouteDecision(rawContent: string): RouteClassifierDecision {
  const normalizedContent = stripCodeFence(rawContent);
  let parsed: unknown;
  try {
    parsed = JSON.parse(normalizedContent);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`route-llm-invalid-json: ${reason}`);
  }
  return normalizeRouteClassifierDecision(parsed);
}

function createConcurrencyLimiter(maxConcurrent: number) {
  const concurrency = Math.max(1, Math.floor(maxConcurrent));
  let activeCount = 0;
  const queue: Array<{
    task: () => Promise<unknown>;
    resolve: (value: unknown) => void;
    reject: (reason?: unknown) => void;
  }> = [];

  const runNext = () => {
    while (activeCount < concurrency && queue.length > 0) {
      const next = queue.shift() as {
        task: () => Promise<unknown>;
        resolve: (value: unknown) => void;
        reject: (reason?: unknown) => void;
      };
      activeCount += 1;
      void (async () => {
        try {
          const value = await next.task();
          next.resolve(value);
        } catch (error) {
          next.reject(error);
        } finally {
          activeCount -= 1;
          runNext();
        }
      })();
    }
  };

  return async <T>(task: () => Promise<T>): Promise<T> => {
    return await new Promise<T>((resolve, reject) => {
      queue.push({
        task: async () => task(),
        resolve: (value) => resolve(value as T),
        reject,
      });
      runNext();
    });
  };
}

function buildRoutePrompt(
  input: Parameters<SecondaryClassifier>[0],
  maxEventTextChars: number
): string {
  const eventText = extractEventText(input.event);
  const payload = {
    uid: input.event.uid,
    source: input.event.source,
    eventKind: input.eventKind,
    kind: input.event.kind,
    action: input.event.action ?? null,
    actor: input.event.actor ?? null,
    ts: input.event.ts,
    primaryOutcome: input.primaryOutcome,
    selfState: input.selfState,
    text:
      typeof eventText === "string"
        ? truncateText(eventText, Math.max(1, maxEventTextChars))
        : null,
  };

  return [
    "Classify whether the assistant should run immediately.",
    "Return JSON object only.",
    JSON.stringify(payload, null, 2),
  ].join("\n");
}

export function resolveRouteLlmRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env
): RouteLlmRuntimeConfig {
  return {
    enabled: parseBoolean(env.ADJUTANT_ROUTE_LLM_ENABLED, false),
    provider: "openai",
    model: parseString(env.ADJUTANT_ROUTE_LLM_MODEL, DEFAULT_ROUTE_LLM_MODEL),
    routeLlmTimeoutMs: parsePositiveInt(
      env.ADJUTANT_ROUTE_LLM_TIMEOUT_MS,
      DEFAULT_ROUTE_LLM_TIMEOUT_MS
    ),
    maxConcurrentRouteLlm: parsePositiveInt(
      env.ADJUTANT_ROUTE_LLM_MAX_CONCURRENT,
      DEFAULT_ROUTE_LLM_MAX_CONCURRENT
    ),
  };
}

export function createOpenAiSecondaryClassifier(
  options: OpenAiSecondaryClassifierOptions
): SecondaryClassifier {
  const model = parseString(options.model, DEFAULT_ROUTE_LLM_MODEL);
  const maxConcurrent = parsePositiveInt(String(options.maxConcurrent ?? "1"), 1);
  const maxEventTextChars = parsePositiveInt(
    String(options.maxEventTextChars ?? DEFAULT_EVENT_TEXT_MAX_CHARS),
    DEFAULT_EVENT_TEXT_MAX_CHARS
  );
  const client =
    options.client ??
    ((): OpenAiChatCompletionClient => {
      const apiKey = options.apiKey?.trim();
      if (!apiKey) {
        throw new Error("OPENAI_API_KEY is required for route LLM classifier");
      }
      return new OpenAI({ apiKey });
    })();
  const withLimit = createConcurrencyLimiter(maxConcurrent);

  return async (input) => {
    return await withLimit(async () => {
      const startedAt = Date.now();
      try {
        const completion = await client.chat.completions.create({
          model,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: ROUTE_SYSTEM_PROMPT },
            { role: "user", content: buildRoutePrompt(input, maxEventTextChars) },
          ],
        });
        const content = completion.choices?.[0]?.message?.content ?? "";
        const decision = parseRouteDecision(content);
        options.onAudit?.({
          event: "route-llm-decision",
          uid: input.event.uid,
          eventKind: input.eventKind,
          model,
          durationMs: Date.now() - startedAt,
          outcome: decision.outcome,
          confidence: decision.confidence,
        });
        return decision.outcome;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        options.onAudit?.({
          event: "route-llm-error",
          uid: input.event.uid,
          eventKind: input.eventKind,
          model,
          durationMs: Date.now() - startedAt,
          reason,
        });
        throw error;
      }
    });
  };
}
