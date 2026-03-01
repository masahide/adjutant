import { randomUUID } from "node:crypto";

import type { AcceptedResponse, RunSummary, SessionRecoveryMode } from "../contracts/http-api.js";

export interface SessionState {
  sessionId: string;
  runSequence: number;
}

export interface RunLifecycleOptions {
  now?: () => string;
  newMessageId?: () => string;
}

export interface RunFailureSummary {
  errorCode: string;
  errorMessage: string;
}

export interface BeginRunMetadata {
  sessionRecovered?: boolean;
  sessionRecoveryMode?: SessionRecoveryMode;
  sessionRecoveryReason?: string;
}

interface IdempotencyRecord {
  requestHash: string;
  accepted: AcceptedResponse;
}

export type IdempotencyResolution =
  | { kind: "miss" }
  | { kind: "duplicate"; accepted: AcceptedResponse }
  | { kind: "conflict"; message: string };

export class RunLifecycle {
  private readonly now: () => string;
  private readonly newMessageId: () => string;
  private readonly sessionsByKey = new Map<string, SessionState>();
  private readonly runIdBySessionId = new Map<string, string>();
  private readonly runById = new Map<string, RunSummary>();
  private readonly idempotencyByKey = new Map<string, IdempotencyRecord>();

  constructor(options: RunLifecycleOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.newMessageId = options.newMessageId ?? (() => `msg_${randomUUID()}`);
  }

  sessions(): Map<string, SessionState> {
    return this.sessionsByKey;
  }

  runs(): Map<string, RunSummary> {
    return this.runById;
  }

  resolveRunId(sessionId: string): string | undefined {
    return this.runIdBySessionId.get(sessionId);
  }

  resolveIdempotency(
    sessionKey: string,
    idempotencyKey: string | undefined,
    requestHash: string
  ): IdempotencyResolution {
    if (idempotencyKey === undefined) {
      return { kind: "miss" };
    }
    const key = this.toIdempotencyStoreKey(sessionKey, idempotencyKey);
    const existing = this.idempotencyByKey.get(key);
    if (existing === undefined) {
      return { kind: "miss" };
    }
    if (existing.requestHash !== requestHash) {
      return {
        kind: "conflict",
        message: "same idempotencyKey was used with different payload",
      };
    }
    return {
      kind: "duplicate",
      accepted: existing.accepted,
    };
  }

  bindIdempotency(
    sessionKey: string,
    idempotencyKey: string | undefined,
    requestHash: string,
    accepted: AcceptedResponse
  ): void {
    if (idempotencyKey === undefined) {
      return;
    }
    const key = this.toIdempotencyStoreKey(sessionKey, idempotencyKey);
    this.idempotencyByKey.set(key, {
      requestHash,
      accepted,
    });
  }

  beginRun(
    sessionKey: string,
    session: SessionState,
    metadata: BeginRunMetadata = {}
  ): AcceptedResponse {
    const nextRunSequence = session.runSequence + 1;
    session.runSequence = nextRunSequence;

    const runId = this.toRunId(session.sessionId, nextRunSequence);
    this.runIdBySessionId.set(session.sessionId, runId);

    const acceptedAt = this.now();
    this.runById.set(runId, {
      runId,
      sessionKey,
      sessionId: session.sessionId,
      status: "accepted",
      acceptedAt,
      sessionRecovered: metadata.sessionRecovered,
      sessionRecoveryMode: metadata.sessionRecoveryMode,
      sessionRecoveryReason: metadata.sessionRecoveryReason,
    });

    const accepted: AcceptedResponse = {
      messageId: this.newMessageId(),
      status: "accepted",
      acceptedAt,
      runId,
    };
    if (metadata.sessionRecovered !== undefined) {
      accepted.sessionRecovered = metadata.sessionRecovered;
    }
    if (metadata.sessionRecoveryMode !== undefined) {
      accepted.sessionRecoveryMode = metadata.sessionRecoveryMode;
    }
    if (metadata.sessionRecoveryReason !== undefined) {
      accepted.sessionRecoveryReason = metadata.sessionRecoveryReason;
    }
    return accepted;
  }

  markRunning(runId: string): void {
    const current = this.runById.get(runId);
    if (current === undefined) {
      return;
    }
    current.status = "running";
    current.startedAt = this.now();
  }

  completeRun(runId: string, stopReason: string): RunSummary | undefined {
    const current = this.runById.get(runId);
    if (current === undefined) {
      return undefined;
    }
    current.status = "completed";
    current.finishedAt = this.now();
    current.stopReason = stopReason;
    return current;
  }

  failRun(runId: string, summary: RunFailureSummary): RunSummary | undefined {
    const current = this.runById.get(runId);
    if (current === undefined) {
      return undefined;
    }
    current.status = "failed";
    current.finishedAt = this.now();
    current.errorCode = summary.errorCode;
    current.errorMessage = summary.errorMessage;
    return current;
  }

  clearActiveSessionRun(sessionId: string): void {
    this.runIdBySessionId.delete(sessionId);
  }

  private toRunId(sessionId: string, runSequence: number): string {
    return `session:${sessionId}:run:${runSequence}`;
  }

  private toIdempotencyStoreKey(sessionKey: string, idempotencyKey: string): string {
    return `${sessionKey}:${idempotencyKey}`;
  }
}
