import { randomUUID } from "node:crypto";

export interface WorkerSession {
  sessionId: string;
  createdAt: string;
  cwd?: string;
}

export class WorkerSessionStore {
  private readonly sessions = new Map<string, WorkerSession>();

  create(input: { cwd?: string } = {}): WorkerSession {
    const session: WorkerSession = {
      sessionId: `sess_${randomUUID()}`,
      createdAt: new Date().toISOString(),
      cwd: input.cwd,
    };

    this.sessions.set(session.sessionId, session);
    return session;
  }

  load(sessionId: string): WorkerSession | undefined {
    return this.sessions.get(sessionId);
  }
}
