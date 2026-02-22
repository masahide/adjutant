import type { AgentRunOptions, AgentRunResult } from "./agent-runner.js";

export class AgentRunExecutor {
  constructor(private readonly execute: (opts: AgentRunOptions) => Promise<AgentRunResult>) {}

  async run(opts: AgentRunOptions): Promise<AgentRunResult> {
    return await this.execute(opts);
  }
}
