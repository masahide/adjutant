import type { WorkerSessionStore } from "../session-store.js";

export interface SessionNewRequest {
  cwd?: string;
}

export interface SessionNewResult {
  sessionId: string;
}

export function handleSessionNew(
  request: SessionNewRequest,
  deps: { sessionStore: WorkerSessionStore }
): SessionNewResult {
  const session = deps.sessionStore.create({ cwd: request.cwd });
  return { sessionId: session.sessionId };
}
