import { createHash } from "node:crypto";

import type { IngestProjection } from "../process-rpc/ingest-projection.js";
import { buildNotificationDecisionPrompt } from "../notification-decision.js";

export type CollectorDispatchPayload = {
  sessionKey: string;
  message: string;
  idempotencyKey: string;
  eventKind: string;
  dedupeSummary: string;
  itemCount: number;
};

function stableBatchKey(values: string[]): string {
  const sorted = [...values].sort((left, right) => left.localeCompare(right));
  return createHash("sha256").update(sorted.join("\n")).digest("hex");
}

export function buildCollectorDispatchPayload(
  projections: IngestProjection[]
): CollectorDispatchPayload {
  if (projections.length === 0) {
    throw new Error("collector dispatch payload requires at least one projection");
  }
  if (projections.length === 1) {
    const first = projections[0];
    return {
      sessionKey: first.sessionKey,
      message:
        first.rawEvent.kind === "notification"
          ? buildNotificationDecisionPrompt(first)
          : first.message,
      idempotencyKey: first.dedupeKey,
      eventKind: first.rawEvent.kind,
      dedupeSummary: first.dedupeKey,
      itemCount: 1,
    };
  }

  const sessionKey = projections[0].sessionKey;
  const message = projections.map((projection) => projection.message).join("\n");
  const dedupeKeys = projections.map((projection) => projection.dedupeKey);
  const batchKey = stableBatchKey(dedupeKeys);
  return {
    sessionKey,
    message,
    idempotencyKey: `batch:${batchKey}`,
    eventKind: "batch",
    dedupeSummary: `${dedupeKeys.length} events`,
    itemCount: projections.length,
  };
}
