import { WorkerRuntimeError } from "../errors.js";
import type { WorkerSessionStore } from "../session-store.js";

export interface SessionLoadRequest {
  sessionId: string;
}

export interface SessionLoadResult {
  sessionId: string;
}

export interface SessionLoadOptions {
  enableLoadSession?: boolean;
}

export function handleSessionLoad(
  request: SessionLoadRequest,
  deps: { sessionStore: WorkerSessionStore },
  options: SessionLoadOptions = {}
): SessionLoadResult {
  if (options.enableLoadSession !== true) {
    throw new WorkerRuntimeError(
      "UNSUPPORTED_CAPABILITY",
      "session/load is disabled by loadSession capability gate",
      false
    );
  }

  const session = deps.sessionStore.load(request.sessionId);
  if (session === undefined) {
    throw new WorkerRuntimeError(
      "INVALID_RECORD",
      `Unknown sessionId: ${request.sessionId}`,
      false
    );
  }

  return { sessionId: session.sessionId };
}
