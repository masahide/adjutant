import {
  ACP_AGENT_METHODS,
  ACP_CLIENT_METHODS,
  ACP_UNSTABLE_AGENT_METHODS,
  type AcpAgentMethod,
  type AcpClientMethod,
  type AcpUnstableAgentMethod,
} from "./method-types.js";

export interface JsonRpcRequest<TParams = unknown> {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params: TParams;
}

export interface JsonRpcNotification<TParams = unknown> {
  jsonrpc: "2.0";
  method: string;
  params: TParams;
}

export interface JsonRpcSuccess<TResult = unknown> {
  jsonrpc: "2.0";
  id: string | number;
  result: TResult;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: string | number | null;
  error: JsonRpcError;
}

export interface InitializeParams {
  protocolVersion: number;
  clientCapabilities: Record<string, unknown>;
}

export interface InitializeResult {
  protocolVersion: number;
  agentCapabilities: Record<string, unknown>;
}

export interface SessionNewParams {
  cwd?: string;
  mcpServers?: Record<string, unknown>;
}

export interface SessionNewResult {
  sessionId: string;
}

export interface SessionPromptParams {
  sessionId: string;
  prompt: string;
  meta?: Record<string, unknown>;
}

export interface SessionPromptResult {
  stopReason: string;
}

export interface SessionLoadParams {
  sessionId: string;
}

export interface SessionLoadResult {
  sessionId: string;
}

export interface SessionCancelParams {
  sessionId: string;
}

export type AgentRequest =
  | (JsonRpcRequest<InitializeParams> & {
      method: typeof ACP_AGENT_METHODS.INITIALIZE;
    })
  | (JsonRpcRequest<SessionNewParams> & {
      method: typeof ACP_AGENT_METHODS.SESSION_NEW;
    })
  | (JsonRpcRequest<SessionLoadParams> & {
      method: typeof ACP_AGENT_METHODS.SESSION_LOAD;
    })
  | (JsonRpcRequest<SessionPromptParams> & {
      method: typeof ACP_AGENT_METHODS.SESSION_PROMPT;
    });

export type AgentNotification = JsonRpcNotification<SessionCancelParams> & {
  method: typeof ACP_AGENT_METHODS.SESSION_CANCEL;
};

export interface SessionUpdateParams {
  sessionId: string;
  update: Record<string, unknown>;
}

export type ClientNotification = JsonRpcNotification<SessionUpdateParams> & {
  method: typeof ACP_CLIENT_METHODS.SESSION_UPDATE;
};

export interface AcpMethodSet {
  stableAgentMethods: AcpAgentMethod[];
  unstableAgentMethods: AcpUnstableAgentMethod[];
  clientMethods: AcpClientMethod[];
}

export const ACP_METHOD_SET: AcpMethodSet = {
  stableAgentMethods: Object.values(ACP_AGENT_METHODS),
  unstableAgentMethods: Object.values(ACP_UNSTABLE_AGENT_METHODS),
  clientMethods: Object.values(ACP_CLIENT_METHODS),
};
