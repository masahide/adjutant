import { loadAcpSchemaMeta } from "./schema-version.js";

export interface AcpSchemaValidationError {
  code: "INVALID_JSON_RPC" | "UNKNOWN_METHOD";
  message: string;
}

export interface AcpSchemaValidationResult {
  ok: boolean;
  error?: AcpSchemaValidationError;
}

export interface AcpVendorValidationOptions {
  allowUnstable?: boolean;
  allowProtocolMethods?: boolean;
}

type JsonRpcLike = {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

let stableMethodCache: Set<string> | undefined;
let unstableMethodCache: Set<string> | undefined;

async function loadAllowedMethods(options: AcpVendorValidationOptions): Promise<Set<string>> {
  if (stableMethodCache === undefined) {
    const stableMeta = await loadAcpSchemaMeta(false);
    stableMethodCache = new Set([
      ...Object.values(stableMeta.agentMethods),
      ...Object.values(stableMeta.clientMethods),
    ]);

    if (options.allowProtocolMethods === true && stableMeta.protocolMethods !== undefined) {
      Object.values(stableMeta.protocolMethods).forEach((method) => stableMethodCache?.add(method));
    }
  }

  if (options.allowUnstable !== true) {
    return new Set(stableMethodCache);
  }

  if (unstableMethodCache === undefined) {
    const unstableMeta = await loadAcpSchemaMeta(true);
    unstableMethodCache = new Set([
      ...Object.values(unstableMeta.agentMethods),
      ...Object.values(unstableMeta.clientMethods),
    ]);

    if (options.allowProtocolMethods === true && unstableMeta.protocolMethods !== undefined) {
      Object.values(unstableMeta.protocolMethods).forEach((method) => {
        unstableMethodCache?.add(method);
      });
    }
  }

  return new Set(unstableMethodCache);
}

export async function validateAcpEnvelopeWithVendorSchema(
  envelope: unknown,
  options: AcpVendorValidationOptions = {}
): Promise<AcpSchemaValidationResult> {
  if (!isObject(envelope)) {
    return {
      ok: false,
      error: {
        code: "INVALID_JSON_RPC",
        message: "Envelope must be an object",
      },
    };
  }

  const rpc = envelope as JsonRpcLike;
  if (rpc.jsonrpc !== "2.0") {
    return {
      ok: false,
      error: {
        code: "INVALID_JSON_RPC",
        message: 'jsonrpc must be "2.0"',
      },
    };
  }

  if (typeof rpc.method !== "string") {
    return {
      ok: false,
      error: {
        code: "INVALID_JSON_RPC",
        message: "method must be a string",
      },
    };
  }

  if (!(typeof rpc.id === "string" || typeof rpc.id === "number" || rpc.id === undefined)) {
    return {
      ok: false,
      error: {
        code: "INVALID_JSON_RPC",
        message: "id must be string, number, or undefined",
      },
    };
  }

  const allowedMethods = await loadAllowedMethods(options);
  if (!allowedMethods.has(rpc.method)) {
    return {
      ok: false,
      error: {
        code: "UNKNOWN_METHOD",
        message: `Method is not defined by vendor schema: ${rpc.method}`,
      },
    };
  }

  return { ok: true };
}
