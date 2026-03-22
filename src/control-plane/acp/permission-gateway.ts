import type { PersistedGuardrailPolicyMatch } from "../../guardrails/types.js";
import {
  PermissionRegistry,
  type PendingPermission,
  type PermissionOutcome,
  type PermissionSelection,
  normalizePermissionSelection,
} from "./permission-registry.js";

export interface PermissionRequestInput {
  requestId: string;
  sessionId: string;
  runId?: string;
  toolCallId?: string;
  title: string;
  reason?: string;
  ruleId?: string;
  policyCandidate?: PersistedGuardrailPolicyMatch;
  timeoutMs?: number;
  timeoutSelection?: PermissionSelection;
}

export interface PermissionGatewayEvent {
  type: "permission/requested" | "permission/resolved";
  payload: Record<string, unknown>;
}

export interface PermissionGatewayOptions {
  registry?: PermissionRegistry;
  emitUiEvent?: (event: PermissionGatewayEvent) => void;
  defaultTimeoutMs?: number;
  defaultTimeoutSelection?: PermissionSelection;
}

export class PermissionGateway {
  private readonly registry: PermissionRegistry;
  private readonly emitUiEvent?: (event: PermissionGatewayEvent) => void;
  private readonly defaultTimeoutMs?: number;
  private readonly defaultTimeoutSelection?: PermissionSelection;
  private readonly timeoutByRequestId = new Map<string, NodeJS.Timeout>();

  constructor(options: PermissionGatewayOptions = {}) {
    this.registry = options.registry ?? new PermissionRegistry();
    this.emitUiEvent = options.emitUiEvent;
    this.defaultTimeoutMs = options.defaultTimeoutMs;
    this.defaultTimeoutSelection = options.defaultTimeoutSelection;
  }

  requestPermission(input: PermissionRequestInput): Promise<PermissionSelection> {
    const timeoutMs = input.timeoutMs ?? this.defaultTimeoutMs;
    const timeoutSelection = input.timeoutSelection ?? this.defaultTimeoutSelection;
    const expiresAt =
      timeoutMs !== undefined ? new Date(Date.now() + timeoutMs).toISOString() : undefined;
    this.emitUiEvent?.({
      type: "permission/requested",
      payload: {
        requestId: input.requestId,
        sessionId: input.sessionId,
        runId: input.runId,
        toolCallId: input.toolCallId,
        title: input.title,
        reason: input.reason,
        ruleId: input.ruleId,
        ...(expiresAt !== undefined ? { expiresAt } : {}),
      },
    });

    const pending = this.registry.register({
      ...input,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    });
    if (timeoutMs !== undefined && timeoutSelection !== undefined) {
      const timer = setTimeout(() => {
        this.resolvePermission(input.requestId, timeoutSelection);
      }, timeoutMs);
      this.timeoutByRequestId.set(input.requestId, timer);
    }
    return pending;
  }

  resolvePermission(requestId: string, selection: PermissionSelection): boolean {
    const timer = this.timeoutByRequestId.get(requestId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timeoutByRequestId.delete(requestId);
    }
    const resolved = this.registry.resolve(requestId, selection);
    if (resolved) {
      this.emitUiEvent?.({
        type: "permission/resolved",
        payload: {
          requestId,
          selection,
          outcome: normalizePermissionSelection(selection),
        },
      });
    }

    return resolved;
  }

  cancelSession(sessionId: string): string[] {
    const cancelled = this.registry.cancelBySession(sessionId);
    cancelled.forEach((requestId) => {
      const timer = this.timeoutByRequestId.get(requestId);
      if (timer !== undefined) {
        clearTimeout(timer);
        this.timeoutByRequestId.delete(requestId);
      }
      this.emitUiEvent?.({
        type: "permission/resolved",
        payload: {
          requestId,
          selection: "cancelled",
          outcome: "cancelled" satisfies PermissionOutcome,
        },
      });
    });

    return cancelled;
  }

  getPending(requestId: string): PendingPermission | undefined {
    return this.registry.getPending(requestId);
  }

  listPending(sessionId?: string): PendingPermission[] {
    return this.registry.listPending(sessionId);
  }
}
