export type AgentRunOrigin = "user" | "pipeline" | "system";
export type AgentMemoryScope = "main" | "spoke";
export type HeartbeatTurnMetadata = {
  source: "heartbeat";
  triggerReason?: string;
  runAt?: string;
};

export type ResolvedAgentRunContext = {
  runId: string;
  prompt: string;
  systemPrompt?: string;
  sessionKey: string;
  sessionId?: string;
  model?: string;
  origin: AgentRunOrigin;
  memoryScope: AgentMemoryScope;
  isHeartbeat: boolean;
  heartbeatMeta?: HeartbeatTurnMetadata;
  memoryWriteEnabled: boolean;
  workspaceDir: string;
  timezone: string;
  sessionEntriesPath: string;
};
