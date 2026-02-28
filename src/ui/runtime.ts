import type { ClientNotification } from "../contracts/acp/rpc-types.js";
import type { PermissionGatewayEvent } from "../control-plane/acp/permission-gateway.js";
import {
  ToolEventBridge,
  type ToolEventBridgeRecord,
} from "../control-plane/acp/tool-event-bridge.js";

export interface UiRuntimeOptions {
  resolveRunId: (sessionId: string) => string | undefined;
}

export class UiRuntime {
  private readonly toolBridge: ToolEventBridge;
  private readonly pendingPermissionById = new Map<string, Record<string, unknown>>();

  constructor(options: UiRuntimeOptions) {
    this.toolBridge = new ToolEventBridge({ resolveRunId: options.resolveRunId });
  }

  onAcpSessionUpdate(notification: ClientNotification): ToolEventBridgeRecord | undefined {
    return this.toolBridge.ingest(notification);
  }

  listToolEvents(runId: string): ToolEventBridgeRecord[] {
    return this.toolBridge.listRun(runId);
  }

  onPermissionEvent(event: PermissionGatewayEvent): void {
    const requestId = event.payload.requestId;
    if (typeof requestId !== "string" || requestId.length === 0) {
      return;
    }

    if (event.type === "permission/requested") {
      this.pendingPermissionById.set(requestId, event.payload);
      return;
    }

    if (event.type === "permission/resolved") {
      this.pendingPermissionById.delete(requestId);
    }
  }

  listPendingPermissions(): Array<Record<string, unknown>> {
    return [...this.pendingPermissionById.values()];
  }
}
