import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "../../contracts/acp/rpc-types.js";
import type { PermissionGateway } from "./permission-gateway.js";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveOptionId(
  request: RequestPermissionRequest,
  target: "allow_once" | "reject_once"
): string {
  const found = request.options.find((option) => option.kind === target);
  return found?.optionId ?? target;
}

export async function handlePermissionRequest(
  request: RequestPermissionRequest,
  deps: {
    permissionGateway: PermissionGateway;
    resolveRunId?: (sessionId: string) => string | undefined;
  }
): Promise<RequestPermissionResponse> {
  const toolCall = asRecord(request.toolCall);
  const requestMeta = asRecord(request._meta);
  const toolCallMeta = asRecord(toolCall?._meta);
  const guardrailMeta = asRecord(requestMeta?.guardrail) ?? asRecord(toolCallMeta?.guardrail);
  const requestId =
    asString(guardrailMeta?.requestId) ??
    asString(toolCall?.toolCallId) ??
    `perm_${Date.now().toString(36)}`;
  const title = asString(guardrailMeta?.title) ?? asString(toolCall?.title) ?? "Permission Request";
  const reason = asString(guardrailMeta?.reason);
  const ruleId = asString(guardrailMeta?.ruleId);

  const outcome = await deps.permissionGateway.requestPermission({
    requestId,
    sessionId: request.sessionId,
    runId: deps.resolveRunId?.(request.sessionId),
    toolCallId: asString(toolCall?.toolCallId),
    title,
    reason,
    ruleId,
  });

  if (outcome === "cancelled") {
    return {
      outcome: {
        outcome: "cancelled",
      },
    };
  }

  return {
    outcome: {
      outcome: "selected",
      optionId: resolveOptionId(request, outcome === "allow" ? "allow_once" : "reject_once"),
    },
  };
}
