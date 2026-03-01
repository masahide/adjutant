import type { SessionRecoveryStore } from "../acp/session-recovery-store.js";
import type { ThreadRepository } from "./thread-repository.js";

interface ErrorSummaryLike {
  errorCode: string;
  errorMessage: string;
}

export interface SessionThreadCoordinatorDeps {
  threadRepository: Pick<ThreadRepository, "ensureForSessionKey">;
  recoveryStore: Pick<SessionRecoveryStore, "upsert">;
  toErrorSummary: (error: unknown) => ErrorSummaryLike;
  onRecoveryPersistFailed?: (input: {
    runId: string;
    sessionKey: string;
    errorCode: string;
    message: string;
  }) => void;
}

export class SessionThreadCoordinator {
  private readonly threadRepository: Pick<ThreadRepository, "ensureForSessionKey">;
  private readonly recoveryStore: Pick<SessionRecoveryStore, "upsert">;
  private readonly toErrorSummary: (error: unknown) => ErrorSummaryLike;
  private readonly onRecoveryPersistFailed?: SessionThreadCoordinatorDeps["onRecoveryPersistFailed"];

  constructor(deps: SessionThreadCoordinatorDeps) {
    this.threadRepository = deps.threadRepository;
    this.recoveryStore = deps.recoveryStore;
    this.toErrorSummary = deps.toErrorSummary;
    this.onRecoveryPersistFailed = deps.onRecoveryPersistFailed;
  }

  async ensureThreadForSession(sessionKey: string): Promise<void> {
    await this.threadRepository.ensureForSessionKey(sessionKey);
  }

  async persistSessionRecovery(input: {
    runId: string;
    sessionKey: string;
    sessionId: string;
    lastRunId: string;
  }): Promise<void> {
    try {
      await this.recoveryStore.upsert({
        sessionKey: input.sessionKey,
        sessionId: input.sessionId,
        lastRunId: input.lastRunId,
      });
    } catch (error) {
      const summary = this.toErrorSummary(error);
      this.onRecoveryPersistFailed?.({
        runId: input.runId,
        sessionKey: input.sessionKey,
        errorCode: summary.errorCode,
        message: summary.errorMessage,
      });
    }
  }
}
