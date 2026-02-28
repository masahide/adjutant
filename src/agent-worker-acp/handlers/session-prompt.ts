import type { SessionPromptParams } from "../../contracts/acp/rpc-types.js";

import type {
  AgentRunnerAdapter,
  SessionPromptExecutionResult,
} from "../adapters/agent-runner-adapter.js";

export async function handleSessionPrompt(
  params: SessionPromptParams,
  deps: { adapter: AgentRunnerAdapter }
): Promise<SessionPromptExecutionResult> {
  return deps.adapter.prompt(params);
}
