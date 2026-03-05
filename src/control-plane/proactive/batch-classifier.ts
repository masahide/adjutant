import type { NormalizedEvent } from "../../core/events.js";

export type ClassifierAction = "respond" | "note" | "ignore";

export type BatchClassifierDecision = {
  action: ClassifierAction;
  confidence: number;
  reason: string;
};

export type BatchClassifierInput = {
  sessionKey: string;
  events: NormalizedEvent[];
};

export type BatchClassifier = {
  classify: (input: BatchClassifierInput) => Promise<BatchClassifierDecision>;
};

export type BatchClassifierOptions = {
  timeoutMs?: number;
  confidenceThreshold?: number;
  classifyChunk?: (input: BatchClassifierInput) => Promise<BatchClassifierDecision>;
  onWarn?: (message: string, meta?: Record<string, unknown>) => void;
};

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`CLASSIFIER_TIMEOUT:${String(timeoutMs)}`));
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

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(1, Math.floor(parsed));
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return parsed;
}

function failClosed(reason: string): BatchClassifierDecision {
  return {
    action: "note",
    confidence: 0,
    reason,
  };
}

export function createBatchClassifier(options: BatchClassifierOptions = {}): BatchClassifier {
  const timeoutMs =
    options.timeoutMs ?? parsePositiveInt(process.env.ADJUTANT_ROUTE_LLM_TIMEOUT_MS, 1_000);
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
      } as BatchClassifierDecision;
    });

  return {
    classify: async (input) => {
      try {
        const decision = await withTimeout(classifyChunk(input), timeoutMs);
        if (decision.confidence < confidenceThreshold) {
          return failClosed("low-confidence-fail-closed");
        }
        if (
          decision.action !== "respond" &&
          decision.action !== "note" &&
          decision.action !== "ignore"
        ) {
          return failClosed("invalid-action-fail-closed");
        }
        return decision;
      } catch (error) {
        options.onWarn?.("batch-classifier.fail-closed", {
          sessionKey: input.sessionKey,
          reason: error instanceof Error ? error.message : String(error),
        });
        return failClosed("classifier-fail-closed");
      }
    },
  };
}
