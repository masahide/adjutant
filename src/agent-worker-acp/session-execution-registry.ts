import { randomUUID } from "node:crypto";

export interface SessionExecutionState {
  sessionId: string;
  runId: string;
  controller: AbortController;
  startedAt: string;
}

export class SessionExecutionRegistry {
  private readonly activeBySessionId = new Map<string, SessionExecutionState>();

  tryStart(sessionId: string): SessionExecutionState | null {
    if (this.activeBySessionId.has(sessionId)) {
      return null;
    }

    const state: SessionExecutionState = {
      sessionId,
      runId: `run_${randomUUID()}`,
      controller: new AbortController(),
      startedAt: new Date().toISOString(),
    };
    this.activeBySessionId.set(sessionId, state);
    return state;
  }

  finish(sessionId: string, runId: string): void {
    const active = this.activeBySessionId.get(sessionId);
    if (active === undefined) {
      return;
    }
    if (active.runId !== runId) {
      return;
    }
    this.activeBySessionId.delete(sessionId);
  }

  cancel(sessionId: string): boolean {
    const active = this.activeBySessionId.get(sessionId);
    if (active === undefined) {
      return false;
    }
    active.controller.abort();
    return true;
  }

  isActive(sessionId: string): boolean {
    return this.activeBySessionId.has(sessionId);
  }
}
