import { ACP_SCHEMA_VERSION } from "../../contracts/acp/schema-version.js";

import { WorkerRuntimeError } from "../errors.js";

export interface InitializeRequest {
  protocolVersion: number;
  clientCapabilities?: Record<string, unknown>;
}

export interface InitializeResult {
  protocolVersion: number;
  agentCapabilities: {
    loadSession: boolean;
    promptSession: boolean;
    cancelSession: boolean;
  };
}

export interface InitializeOptions {
  enableLoadSession?: boolean;
}

export function handleInitialize(
  request: InitializeRequest,
  options: InitializeOptions = {}
): InitializeResult {
  if (request.protocolVersion !== ACP_SCHEMA_VERSION) {
    throw new WorkerRuntimeError(
      "ACP_PROTOCOL_ERROR",
      `Unsupported protocolVersion: ${request.protocolVersion}`,
      false
    );
  }

  return {
    protocolVersion: ACP_SCHEMA_VERSION,
    agentCapabilities: {
      loadSession: options.enableLoadSession === true,
      promptSession: true,
      cancelSession: true,
    },
  };
}
