import type {
  GuardrailContext,
  GuardrailDecisionResult,
  GuardrailRule,
  GuardrailRuleMatch,
  GuardrailToolHubMode,
  NormalizedGuardrailContext,
} from "./types.js";

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
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

export function normalizeGuardrailContext(input: GuardrailContext): NormalizedGuardrailContext {
  const toolName = input.toolName.trim();
  const path = asNonEmptyString(input.input.path);
  const bashCommand = asNonEmptyString(input.input.command);

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
    };
  }

  if (toolName === "tool_hub") {
    const toolHubMode = normalizeToolHubMode(input.input);
    return {
      ...input,
      toolName,
      toolKind: toolHubMode === "execute" ? "custom" : "read",
      readOnly: toolHubMode !== "execute",
      hasExternalSideEffect: toolHubMode === "execute",
      toolHubMode,
      toolHubProvider: asNonEmptyString(input.input.provider),
      toolHubAction: asNonEmptyString(input.input.action),
    };
  }

  return {
    ...input,
    toolName,
    toolKind: "custom",
    readOnly: false,
    hasExternalSideEffect: true,
    path,
    bashCommand,
  };
}

function matchesRule(context: NormalizedGuardrailContext, match: GuardrailRuleMatch): boolean {
  if (match.toolNames !== undefined && !match.toolNames.includes(context.toolName)) {
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
    const command = context.bashCommand?.toLowerCase();
    if (
      command === undefined ||
      !match.bashCommandPrefixes.some((prefix) => command.startsWith(prefix.toLowerCase()))
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
        "sudo ",
        "su ",
        "docker ",
        "podman ",
        "ssh ",
        "scp ",
        "rsync ",
        "mount ",
        "umount ",
        "reboot",
        "shutdown",
        "mkfs",
        "fdisk ",
      ],
    },
  },
  {
    id: "allow-readonly-tools",
    description: "sandbox 内の read-only ツールは自動許可",
    decision: "allow",
    priority: 200,
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
    priority: 190,
    reason: "tool_hub の catalog / help は副作用を持たないため自動実行します。",
    match: {
      toolNames: ["tool_hub"],
      toolHubModes: ["catalog", "provider_help", "action_help"],
      readOnly: true,
      hasExternalSideEffect: false,
    },
  },
  {
    id: "review-side-effecting-tools",
    description: "副作用のあるツールは人間レビューへ送る",
    decision: "review",
    priority: 100,
    reason: "副作用のある実行は人間の承認が必要です。",
    match: {
      toolNames: ["bash", "edit", "write", "tool_hub"],
    },
  },
];

export function evaluateGuardrailDecision(
  input: GuardrailContext,
  rules: GuardrailRule[] = DEFAULT_GUARDRAIL_RULES
): GuardrailDecisionResult {
  const context = normalizeGuardrailContext(input);
  const sortedRules = [...rules].sort(compareRules);
  const matchedRule = sortedRules.find((rule) => matchesRule(context, rule.match));
  const title = `${describeTool(context)} requires approval`;

  if (matchedRule !== undefined) {
    return {
      decision: matchedRule.decision,
      title,
      reason: matchedRule.reason,
      ruleId: matchedRule.id,
      context,
    };
  }

  return {
    decision: "review",
    title,
    reason: "未分類のツール実行は既定で人間レビューへ送ります。",
    context,
  };
}
