import {
  PermissionRegistry,
  type PendingPermission,
  type PermissionOutcome,
} from "./permission-registry.js";

export interface PermissionRequestInput {
  requestId: string;
  sessionId: string;
  runId?: string;
  toolCallId?: string;
  title: string;
  reason?: string;
  ruleId?: string;
}

export interface PermissionGatewayEvent {
  type: "permission/requested" | "permission/resolved";
  payload: Record<string, unknown>;
}

export interface PermissionGatewayOptions {
  registry?: PermissionRegistry;
  emitUiEvent?: (event: PermissionGatewayEvent) => void;
}

export class PermissionGateway {
  private readonly registry: PermissionRegistry;
  private readonly emitUiEvent?: (event: PermissionGatewayEvent) => void;

  constructor(options: PermissionGatewayOptions = {}) {
    this.registry = options.registry ?? new PermissionRegistry();
    this.emitUiEvent = options.emitUiEvent;
  }

  requestPermission(input: PermissionRequestInput): Promise<PermissionOutcome> {
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
      },
    });

    return this.registry.register(input);
  }

  resolvePermission(requestId: string, outcome: PermissionOutcome): boolean {
    const resolved = this.registry.resolve(requestId, outcome);
    if (resolved) {
      this.emitUiEvent?.({
        type: "permission/resolved",
        payload: {
          requestId,
          outcome,
        },
      });
    }

    return resolved;
  }

  cancelSession(sessionId: string): string[] {
    const cancelled = this.registry.cancelBySession(sessionId);
    cancelled.forEach((requestId) => {
      this.emitUiEvent?.({
        type: "permission/resolved",
        payload: {
          requestId,
          outcome: "cancelled",
        },
      });
    });

    return cancelled;
  }

  listPending(sessionId?: string): PendingPermission[] {
    return this.registry.listPending(sessionId);
  }
}
