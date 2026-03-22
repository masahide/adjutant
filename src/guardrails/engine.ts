import type {
  GuardrailContext,
  GuardrailDecisionResult,
  GuardrailLlmAdvisory,
  GuardrailRule,
  GuardrailRuleMatch,
  GuardrailToolHubMode,
  NormalizedGuardrailContext,
  PersistedGuardrailPolicy,
  PersistedGuardrailPolicyMatch,
} from "./types.js";

type GuardrailRuleSource = "builtin" | "persisted";

interface MatchedRule {
  rule: GuardrailRule;
  source: GuardrailRuleSource;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function extractBashCommandPrefix(command: string | undefined): string | undefined {
  if (command === undefined) {
    return undefined;
  }
  const token = command.trim().split(/\s+/, 1)[0]?.toLowerCase();
  return token && token.length > 0 ? token : undefined;
}

function normalizeToolHubMode(input: Record<string, unknown>): GuardrailToolHubMode | undefined {
  const provider = asNonEmptyString(input.provider);
  const action = asNonEmptyString(input.action);
  const hasArgs = Object.prototype.hasOwnProperty.call(input, "args");

  if (provider === undefined) {
    return "catalog";
  }
  if (action === undefined) {
    return "provider_help";
  }
  if (!hasArgs) {
    return "action_help";
  }
  return "execute";
}

function normalizeToolHubExecutionContext(input: GuardrailContext): NormalizedGuardrailContext {
  const toolHubMode = normalizeToolHubMode(input.input);
  const toolHubProvider = asNonEmptyString(input.input.provider);
  const toolHubAction = asNonEmptyString(input.input.action);

  if (toolHubMode !== "execute") {
    return {
      ...input,
      toolName: "tool_hub",
      toolKind: "read",
      readOnly: true,
      hasExternalSideEffect: false,
      toolHubMode,
      toolHubProvider,
      toolHubAction,
    };
  }

  if (toolHubProvider === "memory" && (toolHubAction === "search" || toolHubAction === "get")) {
    return {
      ...input,
      toolName: "tool_hub",
      toolKind: "read",
      readOnly: true,
      hasExternalSideEffect: false,
      toolHubMode,
      toolHubProvider,
      toolHubAction,
    };
  }

  if (toolHubProvider === "memory" && toolHubAction === "write") {
    return {
      ...input,
      toolName: "tool_hub",
      toolKind: "write",
      readOnly: false,
      hasExternalSideEffect: false,
      toolHubMode,
      toolHubProvider,
      toolHubAction,
    };
  }

  if (toolHubProvider === "slack" && toolHubAction === "save-users") {
    return {
      ...input,
      toolName: "tool_hub",
      toolKind: "network",
      readOnly: false,
      hasExternalSideEffect: true,
      toolHubMode,
      toolHubProvider,
      toolHubAction,
    };
  }

  if (toolHubProvider === "slack") {
    return {
      ...input,
      toolName: "tool_hub",
      toolKind: "network",
      readOnly: true,
      hasExternalSideEffect: true,
      toolHubMode,
      toolHubProvider,
      toolHubAction,
    };
  }

  return {
    ...input,
    toolName: "tool_hub",
    toolKind: "custom",
    readOnly: false,
    hasExternalSideEffect: true,
    toolHubMode,
    toolHubProvider,
    toolHubAction,
  };
}

export function normalizeGuardrailContext(input: GuardrailContext): NormalizedGuardrailContext {
  const toolName = input.toolName.trim();
  const path = asNonEmptyString(input.input.path);
  const bashCommand = asNonEmptyString(input.input.command);
  const bashCommandPrefix = extractBashCommandPrefix(bashCommand);

  if (toolName === "read" || toolName === "find" || toolName === "grep" || toolName === "ls") {
    return {
      ...input,
      toolName,
      toolKind: "read",
      readOnly: true,
      hasExternalSideEffect: false,
      path,
    };
  }

  if (toolName === "edit" || toolName === "write") {
    return {
      ...input,
      toolName,
      toolKind: "write",
      readOnly: false,
      hasExternalSideEffect: false,
      path,
    };
  }

  if (toolName === "bash") {
    return {
      ...input,
      toolName,
      toolKind: "exec",
      readOnly: false,
      hasExternalSideEffect: false,
      bashCommand,
      bashCommandPrefix,
    };
  }

  if (toolName === "tool_hub") {
    return normalizeToolHubExecutionContext(input);
  }

  return {
    ...input,
    toolName,
    toolKind: "custom",
    readOnly: false,
    hasExternalSideEffect: true,
    path,
    bashCommand,
    bashCommandPrefix,
  };
}

function matchesRule(context: NormalizedGuardrailContext, match: GuardrailRuleMatch): boolean {
  if (match.toolNames !== undefined && !match.toolNames.includes(context.toolName)) {
    return false;
  }
  if (match.path !== undefined && match.path !== context.path) {
    return false;
  }
  if (match.toolKinds !== undefined && !match.toolKinds.includes(context.toolKind)) {
    return false;
  }
  if (match.readOnly !== undefined && match.readOnly !== context.readOnly) {
    return false;
  }
  if (
    match.hasExternalSideEffect !== undefined &&
    match.hasExternalSideEffect !== context.hasExternalSideEffect
  ) {
    return false;
  }
  if (
    match.toolHubModes !== undefined &&
    (context.toolHubMode === undefined || !match.toolHubModes.includes(context.toolHubMode))
  ) {
    return false;
  }
  if (
    match.toolHubProviders !== undefined &&
    (context.toolHubProvider === undefined ||
      !match.toolHubProviders.includes(context.toolHubProvider))
  ) {
    return false;
  }
  if (
    match.toolHubActions !== undefined &&
    (context.toolHubAction === undefined || !match.toolHubActions.includes(context.toolHubAction))
  ) {
    return false;
  }
  if (match.bashCommandPrefixes !== undefined) {
    const commandPrefix = context.bashCommandPrefix;
    if (
      commandPrefix === undefined ||
      !match.bashCommandPrefixes.some((prefix) => commandPrefix === prefix.toLowerCase())
    ) {
      return false;
    }
  }
  return true;
}

function compareRules(a: GuardrailRule, b: GuardrailRule): number {
  const priorityA = a.priority ?? 0;
  const priorityB = b.priority ?? 0;
  return priorityB - priorityA;
}

function matchSpecificity(match: GuardrailRuleMatch): number {
  let score = 0;
  if (match.toolNames !== undefined) {
    score += 1;
  }
  if (match.path !== undefined) {
    score += 3;
  }
  if (match.toolKinds !== undefined) {
    score += 1;
  }
  if (match.readOnly !== undefined) {
    score += 1;
  }
  if (match.hasExternalSideEffect !== undefined) {
    score += 1;
  }
  if (match.toolHubModes !== undefined) {
    score += 2;
  }
  if (match.toolHubProviders !== undefined) {
    score += 2;
  }
  if (match.toolHubActions !== undefined) {
    score += 3;
  }
  if (match.bashCommandPrefixes !== undefined) {
    score += 2;
  }
  return score;
}

function describeTool(context: NormalizedGuardrailContext): string {
  if (context.toolName === "tool_hub" && context.toolHubMode !== undefined) {
    if (context.toolHubMode === "execute") {
      const provider = context.toolHubProvider ?? "provider";
      const action = context.toolHubAction ?? "action";
      return `tool_hub ${provider}/${action}`;
    }
    return `tool_hub ${context.toolHubMode}`;
  }
  return context.toolName;
}

function buildPersistedRules(policies: PersistedGuardrailPolicy[]): GuardrailRule[] {
  return policies.map((policy) => {
    const match: GuardrailRuleMatch = {};
    if (policy.match.toolName !== undefined) {
      match.toolNames = [policy.match.toolName];
    }
    if (policy.match.path !== undefined) {
      match.path = policy.match.path;
    }
    if (policy.match.toolHubMode !== undefined) {
      match.toolHubModes = [policy.match.toolHubMode];
    }
    if (policy.match.toolHubProvider !== undefined) {
      match.toolHubProviders = [policy.match.toolHubProvider];
    }
    if (policy.match.toolHubAction !== undefined) {
      match.toolHubActions = [policy.match.toolHubAction];
    }
    if (policy.match.bashCommandPrefix !== undefined) {
      match.bashCommandPrefixes = [policy.match.bashCommandPrefix.toLowerCase()];
    }
    return {
      id: policy.policyId,
      description: "persisted guardrail policy",
      decision: policy.effect === "allow" ? "allow" : "forbid",
      priority: policy.effect === "allow" ? 100 : 200,
      reason:
        policy.effect === "allow"
          ? "保存済みのガードレール許可ポリシーに一致したため自動実行します。"
          : "保存済みのガードレール拒否ポリシーに一致したため実行を拒否します。",
      match,
    };
  });
}

function matchesPolicyScope(
  policy: PersistedGuardrailPolicy,
  context: NormalizedGuardrailContext
): boolean {
  if (policy.scope === "global") {
    return true;
  }
  if (policy.scope === "workspace") {
    return (
      typeof policy.scopeKey === "string" &&
      policy.scopeKey.length > 0 &&
      policy.scopeKey === context.workspaceScopeKey
    );
  }
  return (
    typeof policy.scopeKey === "string" &&
    policy.scopeKey.length > 0 &&
    policy.scopeKey === context.sessionId
  );
}

function compareMatchedRules(a: MatchedRule, b: MatchedRule): number {
  const specificity = matchSpecificity(b.rule.match) - matchSpecificity(a.rule.match);
  if (specificity !== 0) {
    return specificity;
  }
  const priority = compareRules(a.rule, b.rule);
  if (priority !== 0) {
    return priority;
  }
  if (a.source === b.source) {
    return 0;
  }
  return a.source === "persisted" ? -1 : 1;
}

function selectWinningRule(matches: MatchedRule[]): MatchedRule | undefined {
  if (matches.length === 0) {
    return undefined;
  }

  const forbids = matches
    .filter((entry) => entry.rule.decision === "forbid")
    .sort(compareMatchedRules);
  if (forbids.length > 0) {
    return forbids[0];
  }

  const persistedAllows = matches
    .filter((entry) => entry.source === "persisted" && entry.rule.decision === "allow")
    .sort(compareMatchedRules);
  if (persistedAllows.length > 0) {
    return persistedAllows[0];
  }

  const builtinMatches = matches
    .filter((entry) => entry.source === "builtin")
    .sort(compareMatchedRules);
  if (builtinMatches.length === 0) {
    return undefined;
  }

  const bestSpecificity = matchSpecificity(builtinMatches[0].rule.match);
  const bestPriority = builtinMatches[0].rule.priority ?? 0;
  const sameTier = builtinMatches.filter((entry) => {
    return (
      matchSpecificity(entry.rule.match) === bestSpecificity &&
      (entry.rule.priority ?? 0) === bestPriority
    );
  });

  const preferredReview = sameTier.find((entry) => entry.rule.decision === "review");
  if (preferredReview !== undefined) {
    return preferredReview;
  }

  return sameTier[0];
}

export function buildGuardrailPolicyCandidate(
  context: NormalizedGuardrailContext
): PersistedGuardrailPolicyMatch | undefined {
  if (context.toolName === "tool_hub") {
    return {
      toolName: "tool_hub",
      ...(context.toolHubMode !== undefined ? { toolHubMode: context.toolHubMode } : {}),
      ...(context.toolHubProvider !== undefined
        ? { toolHubProvider: context.toolHubProvider }
        : {}),
      ...(context.toolHubAction !== undefined ? { toolHubAction: context.toolHubAction } : {}),
    };
  }

  if (context.toolName === "bash") {
    if (context.bashCommandPrefix === undefined) {
      return undefined;
    }
    return {
      toolName: "bash",
      bashCommandPrefix: context.bashCommandPrefix,
    };
  }

  if (context.path !== undefined) {
    return {
      toolName: context.toolName,
      path: context.path,
    };
  }

  return {
    toolName: context.toolName,
  };
}

export const DEFAULT_GUARDRAIL_RULES: GuardrailRule[] = [
  {
    id: "forbid-bash-policy-escalation",
    description: "明示的な権限昇格・ホスト操作系コマンドは禁止",
    decision: "forbid",
    priority: 300,
    reason: "sandbox 境界の外側を狙うコマンドはガードレールで拒否します。",
    match: {
      toolNames: ["bash"],
      bashCommandPrefixes: [
        "sudo",
        "su",
        "docker",
        "podman",
        "ssh",
        "scp",
        "rsync",
        "mount",
        "umount",
        "reboot",
        "shutdown",
        "mkfs",
        "fdisk",
      ],
    },
  },
  {
    id: "allow-readonly-tools",
    description: "sandbox 内の read-only ツールは自動許可",
    decision: "allow",
    priority: 220,
    reason: "sandbox 内の read-only ツールは自動実行します。",
    match: {
      toolNames: ["read", "find", "grep", "ls"],
      readOnly: true,
      hasExternalSideEffect: false,
    },
  },
  {
    id: "allow-tool-hub-discovery",
    description: "tool_hub の catalog / help は自動許可",
    decision: "allow",
    priority: 210,
    reason: "tool_hub の catalog / help は副作用を持たないため自動実行します。",
    match: {
      toolNames: ["tool_hub"],
      toolHubModes: ["catalog", "provider_help", "action_help"],
      readOnly: true,
      hasExternalSideEffect: false,
    },
  },
  {
    id: "allow-toolhub-memory-read",
    description: "memory の read 系 action は自動許可",
    decision: "allow",
    priority: 205,
    reason: "tool_hub memory/search と memory/get は read-only のため自動実行します。",
    match: {
      toolNames: ["tool_hub"],
      toolHubModes: ["execute"],
      toolHubProviders: ["memory"],
      toolHubActions: ["search", "get"],
      readOnly: true,
      hasExternalSideEffect: false,
    },
  },
  {
    id: "review-toolhub-memory-write",
    description: "memory write は人間レビューへ送る",
    decision: "review",
    priority: 170,
    reason: "tool_hub memory/write は永続状態を書き換えるため人間の承認が必要です。",
    match: {
      toolNames: ["tool_hub"],
      toolHubModes: ["execute"],
      toolHubProviders: ["memory"],
      toolHubActions: ["write"],
    },
  },
  {
    id: "review-toolhub-slack-actions",
    description: "slack provider の action 実行は人間レビューへ送る",
    decision: "review",
    priority: 165,
    reason: "tool_hub slack provider の実行は外部アクセスを伴うため人間の承認が必要です。",
    match: {
      toolNames: ["tool_hub"],
      toolHubModes: ["execute"],
      toolHubProviders: ["slack"],
      toolHubActions: ["search", "list-users", "resolve-channel-id", "save-users"],
    },
  },
  {
    id: "review-toolhub-execute-default",
    description: "未分類の tool_hub execute は人間レビューへ送る",
    decision: "review",
    priority: 160,
    reason: "未分類の tool_hub 実行は既定で人間の承認が必要です。",
    match: {
      toolNames: ["tool_hub"],
      toolHubModes: ["execute"],
    },
  },
  {
    id: "review-side-effecting-tools",
    description: "副作用のあるツールは人間レビューへ送る",
    decision: "review",
    priority: 100,
    reason: "副作用のある実行は人間の承認が必要です。",
    match: {
      toolNames: ["bash", "edit", "write"],
    },
  },
];

export function evaluateGuardrailDecision(
  input: GuardrailContext,
  options: {
    rules?: GuardrailRule[];
    persistedPolicies?: PersistedGuardrailPolicy[];
    advisory?: GuardrailLlmAdvisory;
  } = {}
): GuardrailDecisionResult {
  const context = normalizeGuardrailContext(input);
  const rules = options.rules ?? DEFAULT_GUARDRAIL_RULES;
  const persistedRules = buildPersistedRules(
    (options.persistedPolicies ?? []).filter((policy) => matchesPolicyScope(policy, context))
  );
  const matchedRule = selectWinningRule([
    ...persistedRules
      .filter((rule) => matchesRule(context, rule.match))
      .map((rule) => ({ rule, source: "persisted" as const })),
    ...rules
      .filter((rule) => matchesRule(context, rule.match))
      .map((rule) => ({ rule, source: "builtin" as const })),
  ]);
  const title = `${describeTool(context)} requires approval`;

  if (matchedRule !== undefined) {
    return {
      decision: matchedRule.rule.decision,
      title,
      reason: matchedRule.rule.reason,
      ruleId: matchedRule.rule.id,
      policySource: matchedRule.source,
      advisory: options.advisory,
      context,
    };
  }

  return {
    decision: "review",
    title,
    reason: "未分類のツール実行は既定で人間レビューへ送ります。",
    policySource: "default",
    advisory: options.advisory,
    context,
  };
}
