export type AssistantRuntimeConfig = {
  host: string;
  port: number;
  dataDir: string;
  workspaceDir: string;
  timezone: string;
  model?: string;
  timelinePath: string;
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
};

export type AppRuntimeConfig = {
  assistant: AssistantRuntimeConfig;
  idempotency: IdempotencyRuntimeConfig;
  sse: SseRuntimeConfig;
  routeLlm: RouteLlmRuntimeAppConfig;
  heartbeat: HeartbeatRuntimeConfig;
  slack: SlackRuntimeConfig;
};
