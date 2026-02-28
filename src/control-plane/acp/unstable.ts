import {
  ACP_UNSTABLE_AGENT_METHODS,
  type AcpUnstableAgentMethod,
} from "../../contracts/acp/method-types.js";
import { buildCapabilityMatrix, type CapabilityFlags } from "./capability-matrix.js";

export interface UnsupportedCapabilityError {
  code: "UNSUPPORTED_CAPABILITY";
  message: string;
}

export type UnstableMethodGuardResult =
  | { ok: true }
  | {
      ok: false;
      error: UnsupportedCapabilityError;
    };

const UNSTABLE_METHOD_SET = new Set<AcpUnstableAgentMethod>(
  Object.values(ACP_UNSTABLE_AGENT_METHODS)
);

export function isUnstableMethod(method: string): method is AcpUnstableAgentMethod {
  return UNSTABLE_METHOD_SET.has(method as AcpUnstableAgentMethod);
}

export function guardUnstableMethod(
  method: AcpUnstableAgentMethod,
  flags: CapabilityFlags = {}
): UnstableMethodGuardResult {
  const matrix = buildCapabilityMatrix(flags);
  const enabled = matrix.enabledUnstableAgentMethods.has(method);

  if (enabled) {
    return { ok: true };
  }

  return {
    ok: false,
    error: {
      code: "UNSUPPORTED_CAPABILITY",
      message: `${method} is disabled by unstable capability gate`,
    },
  };
}
