export type PermissionOutcome = "allow" | "deny" | "cancelled";

export interface PendingPermission {
  requestId: string;
  sessionId: string;
  runId?: string;
  toolCallId?: string;
  title: string;
  createdAt: string;
}

interface PendingPermissionEntry {
  request: PendingPermission;
  resolve: (outcome: PermissionOutcome) => void;
}

export class PermissionRegistry {
  private readonly entries = new Map<string, PendingPermissionEntry>();

  register(request: Omit<PendingPermission, "createdAt">): Promise<PermissionOutcome> {
    if (this.entries.has(request.requestId)) {
      throw new Error(`Duplicate requestId: ${request.requestId}`);
    }

    const enriched: PendingPermission = {
      ...request,
      createdAt: new Date().toISOString(),
    };

    return new Promise((resolve) => {
      this.entries.set(request.requestId, {
        request: enriched,
        resolve,
      });
    });
  }

  resolve(requestId: string, outcome: PermissionOutcome): boolean {
    const entry = this.entries.get(requestId);
    if (entry === undefined) {
      return false;
    }

    this.entries.delete(requestId);
    entry.resolve(outcome);
    return true;
  }

  cancelBySession(sessionId: string): string[] {
    const cancelled: string[] = [];
    for (const [requestId, entry] of this.entries.entries()) {
      if (entry.request.sessionId !== sessionId) {
        continue;
      }

      this.entries.delete(requestId);
      entry.resolve("cancelled");
      cancelled.push(requestId);
    }

    return cancelled;
  }

  listPending(sessionId?: string): PendingPermission[] {
    const values = [...this.entries.values()].map((entry) => entry.request);
    if (sessionId === undefined) {
      return values;
    }

    return values.filter((entry) => entry.sessionId === sessionId);
  }
}
