import { ACP_CLIENT_METHODS } from "../contracts/acp/method-types.js";
import type {
  JsonRpcFailure,
  JsonRpcSuccess,
  RequestPermissionOutcome,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "../contracts/acp/rpc-types.js";
import type {
  GuardrailPermissionOutcome,
  GuardrailPermissionRequest,
} from "../guardrails/types.js";
import { resolveGuardrailRuntimeConfig } from "../guardrails/config.js";

interface PendingRequest {
  resolve: (value: Record<string, unknown>) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

export interface ControlPlaneClientOptions {
  writeEnvelope: (envelope: unknown) => void;
}

export interface ControlPlaneRequestOptions {
  timeoutMs?: number;
}

export class ControlPlaneClient {
  private nextId = 1_000_000;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly writeEnvelope: (envelope: unknown) => void;

  constructor(options: ControlPlaneClientOptions) {
    this.writeEnvelope = options.writeEnvelope;
  }

  async request(
    method: string,
    params: Record<string, unknown>,
    options: ControlPlaneRequestOptions = {}
  ): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return await new Promise((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? 1_000;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CONTROL_PLANE_TIMEOUT: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (reason) => {
          clearTimeout(timer);
          reject(reason);
        },
        timer,
      });
      this.writeEnvelope({
        jsonrpc: "2.0",
        id,
        method,
        params,
      });
    });
  }

  handleEnvelope(input: JsonRpcSuccess | JsonRpcFailure): boolean {
    const pending = this.pending.get(Number(input.id));
    if (pending === undefined) {
      return false;
    }

    clearTimeout(pending.timer);
    this.pending.delete(Number(input.id));
    if ("error" in input) {
      pending.reject(new Error(input.error.message));
      return true;
    }

    pending.resolve((input.result ?? {}) as Record<string, unknown>);
    return true;
  }

  failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(error);
    }
  }
}

function createPermissionRequest(input: GuardrailPermissionRequest): RequestPermissionRequest {
  return {
    sessionId: input.sessionId,
    toolCall: {
      sessionUpdate: "tool_call",
      toolCallId: input.toolCallId,
      title: input.toolName,
      kind: input.kind,
      status: "pending",
      rawInput: input.rawInput,
      _meta: {
        guardrail: {
          title: input.title,
          reason: input.reason,
          ruleId: input.ruleId,
          runId: input.runId,
          sessionKey: input.sessionKey,
          workspaceScopeKey: input.workspaceScopeKey,
          policyCandidate: input.policyCandidate,
        },
      },
    },
    options: [
      {
        optionId: "allow_once",
        name: "Approve",
        kind: "allow_once",
      },
      {
        optionId: "allow_always",
        name: "Always Approve",
        kind: "allow_always",
      },
      {
        optionId: "reject_once",
        name: "Deny",
        kind: "reject_once",
      },
      {
        optionId: "reject_always",
        name: "Always Deny",
        kind: "reject_always",
      },
    ],
    _meta: {
      guardrail: {
        title: input.title,
        reason: input.reason,
        ruleId: input.ruleId,
        runId: input.runId,
        sessionKey: input.sessionKey,
        workspaceScopeKey: input.workspaceScopeKey,
        policyCandidate: input.policyCandidate,
      },
    },
  };
}

function mapPermissionOutcome(outcome: RequestPermissionOutcome): GuardrailPermissionOutcome {
  if (outcome.outcome === "cancelled") {
    return "cancelled";
  }
  return outcome.optionId === "allow_once" || outcome.optionId === "allow_always"
    ? "allow"
    : "deny";
}

export async function requestPermissionFromControlPlane(
  client: ControlPlaneClient,
  input: GuardrailPermissionRequest
): Promise<GuardrailPermissionOutcome> {
  const config = resolveGuardrailRuntimeConfig({ env: process.env });
  try {
    const response = (await client.request(
      ACP_CLIENT_METHODS.SESSION_REQUEST_PERMISSION,
      createPermissionRequest(input) as unknown as Record<string, unknown>,
      {
        timeoutMs: config.rpcTimeoutMs,
      }
    )) as unknown as RequestPermissionResponse;
    return mapPermissionOutcome(response.outcome);
  } catch {
    return config.rpcTimeoutOutcome;
  }
}
