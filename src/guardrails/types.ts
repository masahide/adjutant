export type GuardrailMode = "off" | "audit" | "enforce";

export type GuardrailDecision = "allow" | "review" | "forbid";

export type GuardrailToolKind = "read" | "write" | "exec" | "network" | "custom";

export type GuardrailToolHubMode = "catalog" | "provider_help" | "action_help" | "execute";

export type GuardrailPolicySource = "builtin" | "persisted" | "default";

export type GuardrailPermissionSelection =
  | "allow_once"
  | "allow_always"
  | "reject_once"
  | "reject_always"
  | "cancelled";

export type GuardrailPermissionOutcome = "allow" | "deny" | "cancelled";

export type PersistedGuardrailPolicyScope = "session" | "workspace" | "global";

export interface PersistedGuardrailPolicyMatch {
  toolName?: string;
  path?: string;
  toolHubMode?: GuardrailToolHubMode;
  toolHubProvider?: string;
  toolHubAction?: string;
  bashCommandPrefix?: string;
}

export interface PersistedGuardrailPolicy {
  policyId: string;
  scope: PersistedGuardrailPolicyScope;
  scopeKey?: string;
  match: PersistedGuardrailPolicyMatch;
  effect: "allow" | "deny";
  createdAt: string;
  createdBy: "user";
}

export interface GuardrailAuditRecord {
  ts: string;
  sessionId: string;
  runId?: string;
  toolCallId: string;
  toolName: string;
  decision: GuardrailDecision;
  reason: string;
  ruleId?: string;
  policySource: GuardrailPolicySource | "llm_advisory";
  advisoryDecision?: GuardrailDecision;
  advisoryConfidence?: number;
}

export interface GuardrailLlmAdvisory {
  recommendedDecision: GuardrailDecision;
  confidence: number;
  reason: string;
  tags: string[];
}

export interface GuardrailContext {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  runId?: string;
  sessionKey?: string;
  workspaceScopeKey?: string;
}

export interface NormalizedGuardrailContext extends GuardrailContext {
  toolKind: GuardrailToolKind;
  readOnly: boolean;
  hasExternalSideEffect: boolean;
  path?: string;
  bashCommand?: string;
  bashCommandPrefix?: string;
  toolHubMode?: GuardrailToolHubMode;
  toolHubProvider?: string;
  toolHubAction?: string;
}

export interface GuardrailRuleMatch {
  toolNames?: string[];
  path?: string;
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
  policySource: GuardrailPolicySource;
  advisory?: GuardrailLlmAdvisory;
  context: NormalizedGuardrailContext;
}

export interface GuardrailPromptContext {
  sessionId: string;
  runId?: string;
  sessionKey?: string;
}

export interface GuardrailPermissionRequest {
  sessionId: string;
  runId?: string;
  sessionKey?: string;
  workspaceScopeKey?: string;
  toolCallId: string;
  toolName: string;
  title: string;
  kind?: string;
  rawInput?: unknown;
  reason: string;
  ruleId?: string;
  policyCandidate?: PersistedGuardrailPolicyMatch;
}
