import type { ToolEventBridgeRecord } from "../../control-plane/acp/tool-event-bridge.js";

interface AuditDetailTabProps {
  runId: string;
  toolEvents: ToolEventBridgeRecord[];
}

export interface AuditDetailTabViewModel {
  runId: string;
  rows: Array<{ id: string; label: string; status: string }>;
}

export function AuditDetailTab({
  runId,
  toolEvents,
}: AuditDetailTabProps): AuditDetailTabViewModel {
  return {
    runId,
    rows: toolEvents.map((event) => ({
      id: event.toolCallId,
      label: event.title ?? event.toolCallId,
      status: event.status ?? "pending",
    })),
  };
}
