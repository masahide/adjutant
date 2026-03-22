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

interface PendingRequest {
  resolve: (value: Record<string, unknown>) => void;
  reject: (reason: Error) => void;
}

export interface ControlPlaneClientOptions {
  writeEnvelope: (envelope: unknown) => void;
}

export class ControlPlaneClient {
  private nextId = 1_000_000;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly writeEnvelope: (envelope: unknown) => void;

  constructor(options: ControlPlaneClientOptions) {
    this.writeEnvelope = options.writeEnvelope;
  }

  async request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return await new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
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
        optionId: "reject_once",
        name: "Deny",
        kind: "reject_once",
      },
    ],
    _meta: {
      guardrail: {
        title: input.title,
        reason: input.reason,
        ruleId: input.ruleId,
        runId: input.runId,
        sessionKey: input.sessionKey,
      },
    },
  };
}

function mapPermissionOutcome(outcome: RequestPermissionOutcome): GuardrailPermissionOutcome {
  if (outcome.outcome === "cancelled") {
    return "cancelled";
  }
  return outcome.optionId === "allow_once" ? "allow" : "deny";
}

export async function requestPermissionFromControlPlane(
  client: ControlPlaneClient,
  input: GuardrailPermissionRequest
): Promise<GuardrailPermissionOutcome> {
  const response = (await client.request(
    ACP_CLIENT_METHODS.SESSION_REQUEST_PERMISSION,
    createPermissionRequest(input) as unknown as Record<string, unknown>
  )) as unknown as RequestPermissionResponse;
  return mapPermissionOutcome(response.outcome);
}
