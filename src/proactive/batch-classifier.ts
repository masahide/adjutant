import type { NormalizedEvent } from "../core/events.js";
import {
  validateReportRouteDecisionInput,
  type ReportRouteDecisionInput,
} from "./routing-tools.js";
import type { ProactiveMetrics } from "./metrics.js";

export type BatchClassifierResult = ReportRouteDecisionInput;

export type BatchClassifier = {
  classify: (input: {
    sessionKey: string;
    events: NormalizedEvent[];
    policy?: Record<string, unknown>;
  }) => Promise<BatchClassifierResult>;
};

export type BatchClassifierOptions = {
  confidenceThreshold?: number;
  timeoutMs?: number;
  metrics?: ProactiveMetrics;
  classifyChunk?: (input: {
    sessionKey: string;
    events: NormalizedEvent[];
    prompt: string;
    policy?: Record<string, unknown>;
  }) => Promise<unknown>;
  onWarn?: (message: string, meta?: Record<string, unknown>) => void;
};

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(1, Math.floor(parsed));
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return parsed;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`batch-classifier-timeout:${String(timeoutMs)}`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function extractEventText(event: NormalizedEvent): string | undefined {
  const detail = asRecord(event.detail);
  if (!detail) {
    return undefined;
  }
  const slack = asRecord(detail.slack);
  if (!slack) {
    return undefined;
  }
  if (typeof slack.text === "string" && slack.text.trim().length > 0) {
    return slack.text.trim();
  }
  if (typeof slack.message_text === "string" && slack.message_text.trim().length > 0) {
    return slack.message_text.trim();
  }
  return undefined;
}

function renderBatchPrompt(events: NormalizedEvent[]): string {
  const lines = events.map((event) => {
    const text = extractEventText(event);
    return text
      ? `[${event.ts}] kind=${event.kind} actor=${event.actor ?? "unknown"} uid=${event.uid} text=${JSON.stringify(text)}`
      : `[${event.ts}] kind=${event.kind} actor=${event.actor ?? "unknown"} uid=${event.uid}`;
  });
  return lines.join("\n");
}

function toNoteResult(reason: string): BatchClassifierResult {
  return {
    action: "note",
    confidence: 0,
    reason,
  };
}

export function createBatchClassifier(options: BatchClassifierOptions = {}): BatchClassifier {
  const timeoutMs =
    options.timeoutMs ?? parsePositiveInt(process.env.ADJUTANT_ROUTE_LLM_TIMEOUT_MS, 1000);
  const confidenceThreshold =
    options.confidenceThreshold ??
    parseNumber(process.env.ADJUTANT_ROUTING_CONFIDENCE_THRESHOLD, 0.7);
  const classifyChunk =
    options.classifyChunk ??
    (async () => {
      return {
        action: "respond",
        confidence: 1,
        reason: "default-respond",
      };
    });

  return {
    classify: async ({ sessionKey, events, policy }) => {
      try {
        options.metrics?.recordRouteLlmCall({ sessionKey });
        const raw = await withTimeout(
          classifyChunk({
            sessionKey,
            events,
            prompt: renderBatchPrompt(events),
            policy,
          }),
          timeoutMs
        );
        const parsed = validateReportRouteDecisionInput(raw);
        if (parsed.confidence < confidenceThreshold) {
          return toNoteResult("low-confidence-fail-closed");
        }
        return parsed;
      } catch (error) {
        options.onWarn?.("batch-classifier-fail-closed", {
          sessionKey,
          reason: error instanceof Error ? error.message : String(error),
        });
        return toNoteResult("batch-classifier-fail-closed");
      }
    },
  };
}
