import { createHash } from "node:crypto";

import type {
  CollectorIngestRequest,
  CollectorIngestResponse,
} from "../../contracts/process-rpc/method-types.js";
import type { IdempotencyStore } from "../idempotency-store.js";
import { validateCollectorIngestRequest } from "../../contracts/process-rpc/rpc-types.js";
import { projectCollectorIngestRequest, type IngestProjection } from "./ingest-projection.js";
import { IngestDedupeStore } from "./ingest-dedupe-store.js";

export class IngestValidationError extends Error {
  readonly code = "INVALID_REQUEST";

  constructor(message: string) {
    super(message);
    this.name = "IngestValidationError";
  }
}

export type CollectorIngestHandlerOptions = {
  dedupeStore?: IngestDedupeStore;
  idempotencyStore?: IdempotencyStore;
  now?: () => Date;
  onAccept?: (
    projection: IngestProjection,
    request: CollectorIngestRequest
  ) => Promise<void> | void;
};

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b)
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

function computePayloadHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export class CollectorIngestHandler {
  private readonly dedupeStore: IngestDedupeStore;
  private readonly idempotencyStore?: IdempotencyStore;
  private readonly now: () => Date;
  private readonly onAccept: CollectorIngestHandlerOptions["onAccept"];

  constructor(options: CollectorIngestHandlerOptions = {}) {
    this.dedupeStore = options.dedupeStore ?? new IngestDedupeStore();
    this.idempotencyStore = options.idempotencyStore;
    this.now = options.now ?? (() => new Date());
    this.onAccept = options.onAccept;
  }

  async accept(params: unknown): Promise<CollectorIngestResponse> {
    if (!validateCollectorIngestRequest(params)) {
      throw new IngestValidationError("collector/ingest params are invalid");
    }

    const payloadHash = computePayloadHash(params.payload);
    if (this.idempotencyStore !== undefined) {
      const persisted = this.idempotencyStore.resolveIngest(params.dedupeKey, payloadHash);
      if (persisted.kind === "conflict") {
        throw new IngestValidationError(persisted.message);
      }
      if (persisted.kind === "duplicate") {
        return {
          messageId: persisted.canonicalMessageId,
          status: "accepted",
          acceptedAt: this.now().toISOString(),
        };
      }
    }

    const existing = this.dedupeStore.get(params.dedupeKey);
    if (existing !== undefined) {
      if (existing.payloadHash !== payloadHash) {
        throw new IngestValidationError("same dedupeKey with different payload is not allowed");
      }
      return {
        messageId: existing.canonicalMessageId,
        status: "accepted",
        acceptedAt: this.now().toISOString(),
      };
    }

    const projection = projectCollectorIngestRequest(params);
    await this.onAccept?.(projection, params);
    this.dedupeStore.put({
      dedupeKey: params.dedupeKey,
      canonicalMessageId: params.messageId,
      payloadHash,
    });
    if (this.idempotencyStore !== undefined) {
      await this.idempotencyStore.bindIngest({
        dedupeKey: params.dedupeKey,
        payloadHash,
        canonicalMessageId: params.messageId,
      });
    }
    return {
      messageId: params.messageId,
      status: "accepted",
      acceptedAt: this.now().toISOString(),
    };
  }
}
