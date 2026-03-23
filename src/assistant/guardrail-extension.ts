import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";

import { GuardrailAuditLog } from "../guardrails/audit-log.js";
import {
  resolveGuardrailRuntimeConfig,
  resolveGuardrailWorkspaceScopeKey,
  type GuardrailRuntimeConfig,
} from "../guardrails/config.js";
import {
  buildGuardrailPolicyCandidate,
  evaluateGuardrailDecision,
  normalizeGuardrailContext,
} from "../guardrails/engine.js";
import { createGuardrailLlmAdvisoryEvaluator } from "../guardrails/llm-advisory.js";
import { GuardrailPolicyStore } from "../guardrails/policy-store.js";
import {
  getGuardrailPromptContext,
  requestGuardrailPermission,
} from "../guardrails/worker-runtime.js";
import type { GuardrailMode } from "../guardrails/types.js";

export interface GuardrailExtensionOptions {
  sessionId: string;
  stateDir?: string;
  mode?: GuardrailMode;
  onWarn?: (message: string, meta?: Record<string, unknown>) => void;
}

interface GuardrailToolCallEventResult {
  block?: boolean;
  reason?: string;
}

function inferToolKind(toolName: string): string {
  if (toolName === "read" || toolName === "find" || toolName === "grep" || toolName === "ls") {
    return "read";
  }
  if (toolName === "edit" || toolName === "write") {
    return "write";
  }
  return "execute";
}

function toToolCallEventResult(reason: string): GuardrailToolCallEventResult {
  return {
    block: true,
    reason,
  };
}

function buildBlockedReason(reason: string, ruleId?: string): string {
  return ruleId ? `[guardrail:${ruleId}] ${reason}` : reason;
}

function emitGuardrailWarning(
  options: GuardrailExtensionOptions,
  message: string,
  meta?: Record<string, unknown>
): void {
  const payload = {
    sessionId: options.sessionId,
    ...(meta ?? {}),
  };
  if (options.onWarn !== undefined) {
    options.onWarn(message, payload);
    return;
  }
  console.warn(`[guardrail-extension] ${message}`, payload);
}

async function appendAuditRecord(
  auditLog: GuardrailAuditLog,
  config: GuardrailRuntimeConfig,
  decision: ReturnType<typeof evaluateGuardrailDecision>
): Promise<void> {
  if (config.mode === "off") {
    return;
  }
  await auditLog.append({
    ts: new Date().toISOString(),
    sessionId: decision.context.sessionId,
    runId: decision.context.runId,
    toolCallId: decision.context.toolCallId,
    toolName: decision.context.toolName,
    decision: decision.decision,
    reason: decision.reason,
    ruleId: decision.ruleId,
    policySource: decision.policySource,
    advisoryDecision: decision.advisory?.recommendedDecision,
    advisoryConfidence: decision.advisory?.confidence,
  });
}

export function createGuardrailExtension(options: GuardrailExtensionOptions): ExtensionFactory {
  const config = resolveGuardrailRuntimeConfig({
    env: process.env,
    mode: options.mode,
    stateDir: options.stateDir,
  });
  const policyStore = GuardrailPolicyStore.fromStateDir(config.stateDir, {
    onWarn: (message, meta) => {
      emitGuardrailWarning(options, message, {
        stateDir: config.stateDir,
        ...(meta ?? {}),
      });
    },
  });
  const auditLog = GuardrailAuditLog.fromStateDir(config.stateDir, {
    onWarn: (message, meta) => {
      emitGuardrailWarning(options, message, {
        stateDir: config.stateDir,
        ...(meta ?? {}),
      });
    },
  });
  const evaluateAdvisory = createGuardrailLlmAdvisoryEvaluator({
    enabled: config.llm.enabled,
    apiKey: config.llm.apiKey,
    model: config.llm.model,
    timeoutMs: config.llm.timeoutMs,
  });
  const workspaceScopeKey = resolveGuardrailWorkspaceScopeKey({
    env: process.env,
    stateDir: config.stateDir,
  });

  return (pi) => {
    pi.on("tool_call", async (event): Promise<GuardrailToolCallEventResult | undefined> => {
      const promptContext = getGuardrailPromptContext(options.sessionId);
      const rawDecisionInput = {
        sessionId: options.sessionId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.input,
        runId: promptContext?.runId,
        sessionKey: promptContext?.sessionKey,
        workspaceScopeKey,
      };
      const persistedPolicies = await policyStore.listPolicies();
      const normalizedForAdvisory = normalizeGuardrailContext(rawDecisionInput);
      const advisory = await evaluateAdvisory({
        context: normalizedForAdvisory,
        raw: rawDecisionInput,
      });
      const decision = evaluateGuardrailDecision(rawDecisionInput, {
        persistedPolicies,
        advisory,
      });
      await appendAuditRecord(auditLog, config, decision);

      if (config.mode === "audit" || decision.decision === "allow") {
        return undefined;
      }

      if (decision.decision === "forbid") {
        return toToolCallEventResult(buildBlockedReason(decision.reason, decision.ruleId));
      }

      const outcome = await requestGuardrailPermission({
        sessionId: options.sessionId,
        runId: promptContext?.runId,
        sessionKey: promptContext?.sessionKey,
        workspaceScopeKey,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        title: decision.title,
        kind: inferToolKind(event.toolName),
        rawInput: event.input,
        reason: decision.reason,
        ruleId: decision.ruleId,
        policyCandidate: buildGuardrailPolicyCandidate(decision.context),
      });

      if (outcome === "allow") {
        return undefined;
      }

      const denyReason =
        outcome === "cancelled"
          ? "permission request cancelled before the tool could run"
          : "tool execution denied by user review";
      return toToolCallEventResult(buildBlockedReason(denyReason, decision.ruleId));
    });
  };
}
