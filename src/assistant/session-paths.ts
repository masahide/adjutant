import { join, resolve } from "node:path";

const DEFAULT_AGENT_ID = "main";
const DEFAULT_STATE_RELATIVE_DIR = join("data", "_assistant");

function sanitizeAgentId(agentId?: string): string {
  const normalized = typeof agentId === "string" ? agentId.trim() : "";
  if (!normalized) {
    return DEFAULT_AGENT_ID;
  }
  return normalized.replace(/[^A-Za-z0-9._-]+/g, "_");
}

function sanitizeSessionKey(sessionKey: string): string {
  const normalized = sessionKey.trim().replace(/[^A-Za-z0-9._-]+/g, "_");
  return normalized || "unknown";
}

export function resolveAdjutantStateDir(params?: {
  env?: NodeJS.ProcessEnv;
  dataDir?: string;
}): string {
  const env = params?.env ?? process.env;
  const configured = env.ADJUTANT_STATE_DIR?.trim();
  if (configured) {
    return resolve(configured);
  }
  const dataDir = params?.dataDir?.trim();
  if (dataDir) {
    return resolve(dataDir, "_assistant");
  }
  return resolve(DEFAULT_STATE_RELATIVE_DIR);
}

export function resolveSessionAgentId(params?: {
  env?: NodeJS.ProcessEnv;
  agentId?: string;
}): string {
  const env = params?.env ?? process.env;
  const configured = params?.agentId?.trim() || env.ADJUTANT_SESSION_AGENT_ID?.trim();
  return sanitizeAgentId(configured);
}

export function resolveAgentStateDir(params: { stateDir: string; agentId?: string }): string {
  return join(
    resolve(params.stateDir),
    "agents",
    resolveSessionAgentId({ agentId: params.agentId })
  );
}

export function resolveSessionTranscriptsDir(params: {
  stateDir: string;
  env?: NodeJS.ProcessEnv;
  agentId?: string;
  overrideDir?: string;
}): string {
  const env = params.env ?? process.env;
  const configured = params.overrideDir?.trim() || env.ADJUTANT_SESSION_TRANSCRIPTS_DIR?.trim();
  if (configured) {
    return resolve(configured);
  }
  return join(
    resolveAgentStateDir({ stateDir: params.stateDir, agentId: params.agentId }),
    "sessions"
  );
}

export function resolveSummaryBatchWatermarkPath(params: {
  stateDir: string;
  agentId?: string;
}): string {
  return join(
    resolveAgentStateDir({ stateDir: params.stateDir, agentId: params.agentId }),
    "summary-batch-watermark.json"
  );
}

export function resolveSessionEntriesPath(params: { stateDir: string; agentId?: string }): string {
  return join(
    resolveAgentStateDir({ stateDir: params.stateDir, agentId: params.agentId }),
    "sessions.json"
  );
}

export function resolveSessionRecordPath(params: {
  stateDir: string;
  sessionKey: string;
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  sessionTranscriptsDir?: string;
}): string {
  const sessionsDir = resolveSessionTranscriptsDir({
    stateDir: params.stateDir,
    agentId: params.agentId,
    env: params.env,
    overrideDir: params.sessionTranscriptsDir,
  });
  return join(sessionsDir, `${sanitizeSessionKey(params.sessionKey)}.jsonl`);
}

export function resolveLegacyWorkspaceSessionsDir(workspaceDir: string): string {
  return join(workspaceDir, "memory", "sessions");
}
