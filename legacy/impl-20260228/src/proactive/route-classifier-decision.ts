import type { RouterOutcome } from "./route-decision.js";

type UnknownRecord = Record<string, unknown>;

export type RouteClassifierDecision = {
  outcome: RouterOutcome;
  confidence?: number;
  reason?: string;
};

function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as UnknownRecord;
}

function normalizeConfidence(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(0, Math.min(1, value));
}

export function normalizeRouteClassifierDecision(raw: unknown): RouteClassifierDecision {
  const payload = asRecord(raw);
  if (!payload) {
    throw new Error("route-llm-invalid-json: expected object");
  }

  const outcome = payload.outcome;
  if (outcome !== "run" && outcome !== "pending") {
    throw new Error("route-llm-invalid-outcome");
  }

  const reason = typeof payload.reason === "string" ? payload.reason.trim() : "";
  return {
    outcome,
    confidence: normalizeConfidence(payload.confidence),
    reason: reason.length > 0 ? reason : undefined,
  };
}
