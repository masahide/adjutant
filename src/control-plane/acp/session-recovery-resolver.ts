import type { SessionRecoveryStore } from "./session-recovery-store.js";
import type { SessionRecoveryMode } from "../contracts/http-api.js";

export interface SessionState {
  sessionId: string;
  runSequence: number;
}

export interface ResolvedSessionState extends SessionState {
  sessionRecovered: boolean;
  recoveryMode: SessionRecoveryMode;
  fallbackReason?: string;
}

export interface SessionRecoveryResolverDeps {
  sessionsByKey: Map<string, SessionState>;
  recoveryStore: SessionRecoveryStore;
  isLoadSessionEnabled: boolean;
  requestWorker: (
    method: "session/load" | "session/new",
    params: Record<string, unknown>
  ) => Promise<Record<string, unknown>>;
}

const ERROR_CODE_PATTERN = /^([A-Z_]+)(?::|$)/;
const RECOVERABLE_LOAD_ERROR_CODES = new Set<string>(["INVALID_RECORD", "UNSUPPORTED_CAPABILITY"]);

function parseRunSequence(lastRunId: string | undefined): number {
  if (typeof lastRunId !== "string" || lastRunId.length === 0) {
    return 0;
  }
  const matched = /:run:(\d+)$/.exec(lastRunId);
  if (matched === null) {
    return 0;
  }
  const parsed = Number.parseInt(matched[1] ?? "0", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function getSessionId(result: Record<string, unknown>): string | undefined {
  return typeof result.sessionId === "string" && result.sessionId.length > 0
    ? result.sessionId
    : undefined;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function extractErrorCode(error: unknown): string | undefined {
  const message = toErrorMessage(error);
  const matched = ERROR_CODE_PATTERN.exec(message);
  return matched?.[1];
}

function shouldFallbackFromLoad(error: unknown): boolean {
  const code = extractErrorCode(error);
  if (code === undefined) {
    return false;
  }
  return RECOVERABLE_LOAD_ERROR_CODES.has(code);
}

function toJournalAppendError(stage: "session/load" | "session/new", error: unknown): Error {
  return new Error(`JOURNAL_APPEND_FAILED: ${stage}: ${toErrorMessage(error)}`);
}

export async function resolveOrCreateSession(
  sessionKey: string,
  deps: SessionRecoveryResolverDeps
): Promise<ResolvedSessionState> {
  const existing = deps.sessionsByKey.get(sessionKey);
  if (existing !== undefined) {
    return {
      sessionId: existing.sessionId,
      runSequence: existing.runSequence,
      sessionRecovered: true,
      recoveryMode: "in_memory",
    };
  }

  const recovered = deps.recoveryStore.get(sessionKey);
  let fallbackReason: string | undefined;
  if (recovered !== undefined && deps.isLoadSessionEnabled) {
    try {
      const loaded = await deps.requestWorker("session/load", { sessionId: recovered.sessionId });
      const sessionId = getSessionId(loaded);
      if (sessionId === undefined) {
        throw new Error("ACP_PROTOCOL_ERROR: session/load did not return sessionId");
      }

      const resolved: ResolvedSessionState = {
        sessionId,
        runSequence: parseRunSequence(recovered.lastRunId),
        sessionRecovered: true,
        recoveryMode: "session_load",
      };
      deps.sessionsByKey.set(sessionKey, resolved);
      try {
        await deps.recoveryStore.upsert({
          sessionKey,
          sessionId,
          lastRunId: recovered.lastRunId,
        });
      } catch (error) {
        throw toJournalAppendError("session/load", error);
      }
      return resolved;
    } catch (error) {
      if (!shouldFallbackFromLoad(error)) {
        throw error;
      }
      fallbackReason = toErrorMessage(error);
      // fall through to session/new on recoverable load errors
    }
  }

  const created = await deps.requestWorker("session/new", {});
  const sessionId = getSessionId(created);
  if (sessionId === undefined) {
    throw new Error("ACP_PROTOCOL_ERROR: session/new did not return sessionId");
  }

  const next: ResolvedSessionState = {
    sessionId,
    runSequence: 0,
    sessionRecovered: false,
    recoveryMode: fallbackReason ? "fallback_new_session" : "new_session",
    fallbackReason,
  };
  deps.sessionsByKey.set(sessionKey, next);
  try {
    await deps.recoveryStore.upsert({ sessionKey, sessionId });
  } catch (error) {
    throw toJournalAppendError("session/new", error);
  }
  return next;
}
