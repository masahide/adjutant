export type AssistantRuntimeConfig = {
  host: string;
  port: number;
  dataDir: string;
  workspaceDir: string;
  timezone: string;
  model?: string;
  timelinePath: string;
};

export type SessionStorageRuntimeConfig = {
  stateDir: string;
  agentId: string;
  transcriptsDir: string;
  sessionEntriesPath: string;
};

export type IdempotencyRuntimeConfig = {
  storePath: string;
  maxEntries: number;
  failureMode: "open" | "closed";
};

export type SseRuntimeConfig = {
  replayBufferSize: number;
  replayMaxAgeMs: number;
};

export type RouteLlmRuntimeAppConfig = {
  enabled: boolean;
  provider: "openai";
  model: string;
  timeoutMs: number;
  maxConcurrent: number;
};

export type HeartbeatRuntimeConfig = {
  intervalMs: number;
  staleMs: number;
};

export type SlackRuntimeConfig = {
  retryBaseMs: number;
  retryMaxMs: number;
  defaultAccountId: string;
  domCaptureDisabled: boolean;
};

export type AgentAuditRuntimeConfig = {
  enabled: boolean;
  path: string;
  maxFieldChars: number;
};

export type MarkdownSummaryBatchRuntimeConfig = {
  enabled: boolean;
  intervalMs: number;
  messages: number;
  maxSessions: number;
};

export type SandboxRuntimeConfig = {
  mode: "off" | "non-main" | "all";
  docker: {
    image: string;
    autoBuildImage: boolean;
    containerPrefix: string;
    workdir: string;
    readOnlyRoot: boolean;
    tmpfs: string[];
    network: string | undefined;
    capDrop: string[];
    pidsLimit: number | undefined;
    memory: string | undefined;
  };
};

export type AppRuntimeConfig = {
  assistant: AssistantRuntimeConfig;
  agentAudit: AgentAuditRuntimeConfig;
  sessionStorage: SessionStorageRuntimeConfig;
  markdownSummaryBatch: MarkdownSummaryBatchRuntimeConfig;
  sandbox: SandboxRuntimeConfig;
  idempotency: IdempotencyRuntimeConfig;
  sse: SseRuntimeConfig;
  routeLlm: RouteLlmRuntimeAppConfig;
  heartbeat: HeartbeatRuntimeConfig;
  slack: SlackRuntimeConfig;
};
