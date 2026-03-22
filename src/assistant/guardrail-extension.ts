import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";

import { evaluateGuardrailDecision } from "../guardrails/engine.js";
import {
  getGuardrailPromptContext,
  requestGuardrailPermission,
} from "../guardrails/worker-runtime.js";

export interface GuardrailExtensionOptions {
  sessionId: string;
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
    return "edit";
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

export function createGuardrailExtension(options: GuardrailExtensionOptions): ExtensionFactory {
  return (pi) => {
    pi.on("tool_call", async (event): Promise<GuardrailToolCallEventResult | undefined> => {
      const promptContext = getGuardrailPromptContext(options.sessionId);
      const decision = evaluateGuardrailDecision({
        sessionId: options.sessionId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.input,
        runId: promptContext?.runId,
        sessionKey: promptContext?.sessionKey,
      });

      if (decision.decision === "allow") {
        return undefined;
      }

      if (decision.decision === "forbid") {
        return toToolCallEventResult(buildBlockedReason(decision.reason, decision.ruleId));
      }

      const outcome = await requestGuardrailPermission({
        sessionId: options.sessionId,
        runId: promptContext?.runId,
        sessionKey: promptContext?.sessionKey,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        title: decision.title,
        kind: inferToolKind(event.toolName),
        rawInput: event.input,
        reason: decision.reason,
        ruleId: decision.ruleId,
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
