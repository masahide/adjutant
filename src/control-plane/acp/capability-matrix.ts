import {
  ACP_AGENT_METHODS,
  ACP_CLIENT_METHODS,
  ACP_UNSTABLE_AGENT_METHODS,
  type AcpAgentMethod,
  type AcpClientMethod,
  type AcpMethod,
  type AcpUnstableAgentMethod,
} from "../../contracts/acp/method-types.js";

export interface CapabilityFlags {
  enableUnstableSessionMethods?: boolean;
  enableFsCapability?: boolean;
  enableTerminalGateway?: boolean;
}

export interface CapabilityMatrix {
  enabledStableAgentMethods: ReadonlySet<AcpAgentMethod>;
  enabledUnstableAgentMethods: ReadonlySet<AcpUnstableAgentMethod>;
  enabledClientMethods: ReadonlySet<AcpClientMethod>;
}

// ACP-207: FS capability stays disabled in v1 even if experimental flags are provided.
export const ACP_V1_FS_CAPABILITY_ENABLED = false;

const BASE_CLIENT_METHODS: AcpClientMethod[] = [
  ACP_CLIENT_METHODS.SESSION_UPDATE,
  ACP_CLIENT_METHODS.SESSION_REQUEST_PERMISSION,
];

const FS_CLIENT_METHODS: AcpClientMethod[] = [
  ACP_CLIENT_METHODS.FS_READ_TEXT_FILE,
  ACP_CLIENT_METHODS.FS_WRITE_TEXT_FILE,
];

const TERMINAL_CLIENT_METHODS: AcpClientMethod[] = [
  ACP_CLIENT_METHODS.TERMINAL_CREATE,
  ACP_CLIENT_METHODS.TERMINAL_OUTPUT,
  ACP_CLIENT_METHODS.TERMINAL_WAIT_FOR_EXIT,
  ACP_CLIENT_METHODS.TERMINAL_KILL,
  ACP_CLIENT_METHODS.TERMINAL_RELEASE,
];

export function buildCapabilityMatrix(flags: CapabilityFlags = {}): CapabilityMatrix {
  const stable = new Set<AcpAgentMethod>(Object.values(ACP_AGENT_METHODS));

  const unstable = new Set<AcpUnstableAgentMethod>();
  if (flags.enableUnstableSessionMethods === true) {
    Object.values(ACP_UNSTABLE_AGENT_METHODS).forEach((method) => unstable.add(method));
  }

  const client = new Set<AcpClientMethod>(BASE_CLIENT_METHODS);
  if (flags.enableFsCapability === true && ACP_V1_FS_CAPABILITY_ENABLED) {
    FS_CLIENT_METHODS.forEach((method) => client.add(method));
  }
  if (flags.enableTerminalGateway === true) {
    TERMINAL_CLIENT_METHODS.forEach((method) => client.add(method));
  }

  return {
    enabledStableAgentMethods: stable,
    enabledUnstableAgentMethods: unstable,
    enabledClientMethods: client,
  };
}

export function isAgentMethodEnabled(matrix: CapabilityMatrix, method: AcpMethod): boolean {
  return (
    matrix.enabledStableAgentMethods.has(method as AcpAgentMethod) ||
    matrix.enabledUnstableAgentMethods.has(method as AcpUnstableAgentMethod)
  );
}

export function isClientMethodEnabled(matrix: CapabilityMatrix, method: AcpClientMethod): boolean {
  return matrix.enabledClientMethods.has(method);
}
