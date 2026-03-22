import type { PersistedGuardrailPolicyMatch } from "../../guardrails/types.js";

export type PermissionSelection =
  | "allow_once"
  | "allow_always"
  | "reject_once"
  | "reject_always"
  | "cancelled";

export type PermissionOutcome = "allow" | "deny" | "cancelled";

export interface PendingPermission {
  requestId: string;
  sessionId: string;
  runId?: string;
  toolCallId?: string;
  title: string;
  reason?: string;
  ruleId?: string;
  policyCandidate?: PersistedGuardrailPolicyMatch;
  createdAt: string;
  expiresAt?: string;
}

interface PendingPermissionEntry {
  request: PendingPermission;
  resolve: (outcome: PermissionSelection) => void;
}

export interface PermissionRegisterInput
  extends Omit<PendingPermission, "createdAt" | "expiresAt"> {
  expiresAt?: string;
}

export function normalizePermissionSelection(outcome: PermissionSelection): PermissionOutcome {
  if (outcome === "allow_once" || outcome === "allow_always") {
    return "allow";
  }
  if (outcome === "cancelled") {
    return "cancelled";
  }
  return "deny";
}

export class PermissionRegistry {
  private readonly entries = new Map<string, PendingPermissionEntry>();

  register(request: PermissionRegisterInput): Promise<PermissionSelection> {
    if (this.entries.has(request.requestId)) {
      throw new Error(`Duplicate requestId: ${request.requestId}`);
    }

    const createdAt = new Date().toISOString();
    const enriched: PendingPermission = {
      ...request,
      createdAt,
      ...(request.expiresAt !== undefined ? { expiresAt: request.expiresAt } : {}),
    };

    return new Promise((resolve) => {
      this.entries.set(request.requestId, {
        request: enriched,
        resolve,
      });
    });
  }

  resolve(requestId: string, selection: PermissionSelection): boolean {
    const entry = this.entries.get(requestId);
    if (entry === undefined) {
      return false;
    }

    this.entries.delete(requestId);
    entry.resolve(selection);
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

  getPending(requestId: string): PendingPermission | undefined {
    return this.entries.get(requestId)?.request;
  }

  listPending(sessionId?: string): PendingPermission[] {
    const values = [...this.entries.values()].map((entry) => entry.request);
    if (sessionId === undefined) {
      return values;
    }

    return values.filter((entry) => entry.sessionId === sessionId);
  }
}
