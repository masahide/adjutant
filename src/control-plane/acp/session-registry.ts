export interface SessionBinding {
  sessionId: string;
  sessionKey: string;
  runId: string;
  runSequence: number;
}

export function toSessionKey(sessionId: string): string {
  return `session:${sessionId}`;
}

export function toRunId(sessionKey: string, runSequence: number): string {
  return `${sessionKey}:run:${runSequence}`;
}

export class SessionRegistry {
  private readonly bindings = new Map<string, SessionBinding>();
  private readonly sessionIdByKey = new Map<string, string>();

  registerSession(sessionId: string, sessionKey = toSessionKey(sessionId)): SessionBinding {
    const existingSessionId = this.sessionIdByKey.get(sessionKey);
    if (existingSessionId !== undefined && existingSessionId !== sessionId) {
      throw new Error(`sessionKey already bound: ${sessionKey}`);
    }

    const current = this.bindings.get(sessionId);
    if (current !== undefined) {
      return current;
    }

    const binding: SessionBinding = {
      sessionId,
      sessionKey,
      runSequence: 0,
      runId: toRunId(sessionKey, 0),
    };

    this.bindings.set(sessionId, binding);
    this.sessionIdByKey.set(sessionKey, sessionId);
    return binding;
  }

  startRun(sessionId: string): SessionBinding {
    const current = this.bindings.get(sessionId);
    if (current === undefined) {
      throw new Error(`sessionId not registered: ${sessionId}`);
    }

    const nextSequence = current.runSequence + 1;
    const updated: SessionBinding = {
      ...current,
      runSequence: nextSequence,
      runId: toRunId(current.sessionKey, nextSequence),
    };

    this.bindings.set(sessionId, updated);
    return updated;
  }

  resolveBySessionId(sessionId: string): SessionBinding | undefined {
    return this.bindings.get(sessionId);
  }

  resolveBySessionKey(sessionKey: string): SessionBinding | undefined {
    const sessionId = this.sessionIdByKey.get(sessionKey);
    if (sessionId === undefined) {
      return undefined;
    }
    return this.bindings.get(sessionId);
  }
}
