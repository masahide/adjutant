export type ReportRouteDecisionInput = {
  action: "respond" | "note" | "ignore";
  confidence: number;
  reason: string;
};

export type ReportHeartbeatStatusInput = {
  status: "no_action_needed" | "needs_attention" | "task_completed";
  notify: boolean;
  reason: string;
};

export const REPORT_ROUTE_DECISION_TOOL = {
  name: "report_route_decision",
  description: "Return a routing decision for the current message batch.",
} as const;

export const REPORT_HEARTBEAT_STATUS_TOOL = {
  name: "report_heartbeat_status",
  description: "Return a structured status for heartbeat execution.",
} as const;

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }
  return normalized;
}

export function validateReportRouteDecisionInput(value: unknown): ReportRouteDecisionInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("route decision must be an object");
  }
  const source = value as Record<string, unknown>;
  const action = source.action;
  if (action !== "respond" && action !== "note" && action !== "ignore") {
    throw new Error("route decision action is invalid");
  }
  const confidence = Number(source.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error("route decision confidence must be between 0 and 1");
  }
  const reason = asNonEmptyString(source.reason);
  if (!reason) {
    throw new Error("route decision reason is required");
  }
  return { action, confidence, reason };
}

export function validateReportHeartbeatStatusInput(value: unknown): ReportHeartbeatStatusInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("heartbeat status must be an object");
  }
  const source = value as Record<string, unknown>;
  const status = source.status;
  if (
    status !== "no_action_needed" &&
    status !== "needs_attention" &&
    status !== "task_completed"
  ) {
    throw new Error("heartbeat status is invalid");
  }
  const notify = source.notify;
  if (typeof notify !== "boolean") {
    throw new Error("heartbeat notify must be boolean");
  }
  const reason = asNonEmptyString(source.reason);
  if (!reason) {
    throw new Error("heartbeat reason is required");
  }
  return { status, notify, reason };
}
