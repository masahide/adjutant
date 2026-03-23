import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "../../contracts/acp/rpc-types.js";
import { GuardrailPolicyStore } from "../../guardrails/policy-store.js";
import type { PersistedGuardrailPolicyMatch } from "../../guardrails/types.js";
import type { PermissionGateway } from "./permission-gateway.js";
import type { PermissionSelection } from "./permission-registry.js";

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

function parsePolicyCandidate(value: unknown): PersistedGuardrailPolicyMatch | undefined {
  const record = asRecord(value);
  if (record === undefined) {
    return undefined;
  }
  const candidate: PersistedGuardrailPolicyMatch = {};
  const toolName = asString(record.toolName);
  const path = asString(record.path);
  const toolHubMode = asString(record.toolHubMode);
  const toolHubProvider = asString(record.toolHubProvider);
  const toolHubAction = asString(record.toolHubAction);
  const bashCommandPrefix = asString(record.bashCommandPrefix);
  if (toolName !== undefined) {
    candidate.toolName = toolName;
  }
  if (path !== undefined) {
    candidate.path = path;
  }
  if (
    toolHubMode === "catalog" ||
    toolHubMode === "provider_help" ||
    toolHubMode === "action_help" ||
    toolHubMode === "execute"
  ) {
    candidate.toolHubMode = toolHubMode;
  }
  if (toolHubProvider !== undefined) {
    candidate.toolHubProvider = toolHubProvider;
  }
  if (toolHubAction !== undefined) {
    candidate.toolHubAction = toolHubAction;
  }
  if (bashCommandPrefix !== undefined) {
    candidate.bashCommandPrefix = bashCommandPrefix;
  }
  return Object.keys(candidate).length > 0 ? candidate : undefined;
}

function parseWorkspaceScopeKey(value: unknown): string | undefined {
  return asString(value);
}

function resolveOptionId(
  request: RequestPermissionRequest,
  selection: PermissionSelection
): string {
  if (selection === "cancelled") {
    return "cancelled";
  }
  const found = request.options.find((option) => option.kind === selection);
  return found?.optionId ?? selection;
}

async function persistPolicyIfNeeded(input: {
  selection: PermissionSelection;
  policyCandidate?: PersistedGuardrailPolicyMatch;
  workspaceScopeKey?: string;
  policyStore?: GuardrailPolicyStore;
}): Promise<void> {
  if (input.policyStore === undefined || input.policyCandidate === undefined) {
    return;
  }
  if (input.selection !== "allow_always" && input.selection !== "reject_always") {
    return;
  }

  await input.policyStore.persistPolicy({
    scope: "workspace",
    scopeKey: input.workspaceScopeKey,
    match: input.policyCandidate,
    effect: input.selection === "allow_always" ? "allow" : "deny",
  });
}

export async function handlePermissionRequest(
  request: RequestPermissionRequest,
  deps: {
    permissionGateway: PermissionGateway;
    policyStore?: GuardrailPolicyStore;
    resolveRunId?: (sessionId: string) => string | undefined;
    onWarn?: (message: string, meta?: Record<string, unknown>) => void;
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
  const policyCandidate = parsePolicyCandidate(guardrailMeta?.policyCandidate);
  const workspaceScopeKey = parseWorkspaceScopeKey(guardrailMeta?.workspaceScopeKey);

  const selection = await deps.permissionGateway.requestPermission({
    requestId,
    sessionId: request.sessionId,
    runId: deps.resolveRunId?.(request.sessionId),
    toolCallId: asString(toolCall?.toolCallId),
    title,
    reason,
    ruleId,
    policyCandidate,
  });

  if (selection === "cancelled") {
    return {
      outcome: {
        outcome: "cancelled",
      },
    };
  }

  try {
    await persistPolicyIfNeeded({
      selection,
      policyCandidate,
      workspaceScopeKey,
      policyStore: deps.policyStore,
    });
  } catch (error) {
    deps.onWarn?.("failed to persist guardrail policy candidate", {
      sessionId: request.sessionId,
      requestId,
      toolCallId: asString(toolCall?.toolCallId),
      selection,
      workspaceScopeKey,
      policyCandidate,
      error: error instanceof Error ? error.message : String(error),
    });
    // 永続化失敗は将来の自動判定にだけ影響させ、今回の承認結果は通す。
  }

  return {
    outcome: {
      outcome: "selected",
      optionId: resolveOptionId(request, selection),
    },
  };
}
