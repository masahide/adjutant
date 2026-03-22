export type GuardrailDecision = "allow" | "review" | "forbid";

export type GuardrailToolKind = "read" | "write" | "exec" | "network" | "custom";

export type GuardrailToolHubMode = "catalog" | "provider_help" | "action_help" | "execute";

export interface GuardrailContext {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  runId?: string;
  sessionKey?: string;
}

export interface NormalizedGuardrailContext extends GuardrailContext {
  toolKind: GuardrailToolKind;
  readOnly: boolean;
  hasExternalSideEffect: boolean;
  path?: string;
  bashCommand?: string;
  toolHubMode?: GuardrailToolHubMode;
  toolHubProvider?: string;
  toolHubAction?: string;
}

export interface GuardrailRuleMatch {
  toolNames?: string[];
  toolKinds?: GuardrailToolKind[];
  readOnly?: boolean;
  hasExternalSideEffect?: boolean;
  toolHubModes?: GuardrailToolHubMode[];
  toolHubProviders?: string[];
  toolHubActions?: string[];
  bashCommandPrefixes?: string[];
}

export interface GuardrailRule {
  id: string;
  description: string;
  decision: GuardrailDecision;
  priority?: number;
  reason: string;
  match: GuardrailRuleMatch;
}

export interface GuardrailDecisionResult {
  decision: GuardrailDecision;
  title: string;
  reason: string;
  ruleId?: string;
  context: NormalizedGuardrailContext;
}

export interface GuardrailPromptContext {
  sessionId: string;
  runId?: string;
  sessionKey?: string;
}

export type GuardrailPermissionOutcome = "allow" | "deny" | "cancelled";

export interface GuardrailPermissionRequest {
  sessionId: string;
  runId?: string;
  sessionKey?: string;
  toolCallId: string;
  toolName: string;
  title: string;
  kind?: string;
  rawInput?: unknown;
  reason: string;
  ruleId?: string;
}
