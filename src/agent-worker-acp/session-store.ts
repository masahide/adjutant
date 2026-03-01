import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface WorkerSession {
  sessionId: string;
  createdAt: string;
  cwd?: string;
}

export class WorkerSessionStore {
  private readonly sessions = new Map<string, WorkerSession>();
  private readonly filePath?: string;

  constructor(options: { filePath?: string } = {}) {
    this.filePath = options.filePath;
    this.loadFromDisk();
  }

  create(input: { cwd?: string } = {}): WorkerSession {
    const session: WorkerSession = {
      sessionId: `sess_${randomUUID()}`,
      createdAt: new Date().toISOString(),
      cwd: input.cwd,
    };

    this.sessions.set(session.sessionId, session);
    this.persistToDisk();
    return session;
  }

  load(sessionId: string): WorkerSession | undefined {
    return this.sessions.get(sessionId);
  }

  private loadFromDisk(): void {
    if (!this.filePath) {
      return;
    }

    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) {
        return;
      }
      for (const entry of parsed) {
        if (
          typeof entry !== "object" ||
          entry === null ||
          typeof (entry as Record<string, unknown>).sessionId !== "string" ||
          typeof (entry as Record<string, unknown>).createdAt !== "string"
        ) {
          continue;
        }
        const record = entry as WorkerSession;
        this.sessions.set(record.sessionId, record);
      }
    } catch {
      // ignore broken persistence and continue with in-memory state
    }
  }

  private persistToDisk(): void {
    if (!this.filePath) {
      return;
    }

    mkdirSync(dirname(this.filePath), { recursive: true });
    const payload = JSON.stringify([...this.sessions.values()]);
    writeFileSync(this.filePath, `${payload}\n`, "utf8");
  }
}
