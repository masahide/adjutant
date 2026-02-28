import type { AgentRunnerAdapter } from "../adapters/agent-runner-adapter.js";

export interface SessionCancelResult {
  cancelled: boolean;
}

export function handleSessionCancel(
  params: { sessionId: string },
  deps: { adapter: Pick<AgentRunnerAdapter, "cancelSession"> }
): SessionCancelResult {
  return {
    cancelled: deps.adapter.cancelSession(params.sessionId),
  };
}
