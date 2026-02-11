import { join, resolve as resolvePath } from "node:path";

export interface ServerConfig {
  dataDir: string;
  configDir: string;
  slackWorkspaceBaseUrl: string | null;
}

let cachedConfig: ServerConfig | null = null;

export function loadServerConfig(): ServerConfig {
  if (cachedConfig) {
    return cachedConfig;
  }

  const dataDirEnv = process.env.REACLOG_DATA_DIR;
  const initCwd = process.env.INIT_CWD;

  const fallbackDir = initCwd && initCwd.length > 0 ? join(initCwd, "data") : "data";
  const dataDir = resolvePath(dataDirEnv && dataDirEnv.length > 0 ? dataDirEnv : fallbackDir);

  const configDirEnv = process.env.REACLOG_CONFIG_DIR;
  const fallbackConfigDir = initCwd && initCwd.length > 0 ? join(initCwd, "config") : "config";
  const configDir = resolvePath(
    configDirEnv && configDirEnv.length > 0 ? configDirEnv : fallbackConfigDir
  );

  const slackWorkspaceBaseUrl = normalizeSlackWorkspaceUrl(
    process.env.REACLOG_SLACK_WORKSPACE ?? process.env.REACLOG_SLACK_WORKSPACE_URL
  );

  cachedConfig = {
    dataDir,
    configDir,
    slackWorkspaceBaseUrl,
  };

  return cachedConfig;
}

export function resolveDataDir(): string {
  return loadServerConfig().dataDir;
}

export function resolveConfigDir(): string {
  return loadServerConfig().configDir;
}

export function resolveSlackWorkspaceBaseUrl(): string | null {
  return loadServerConfig().slackWorkspaceBaseUrl;
}

export function resetConfigCache(): void {
  cachedConfig = null;
}

function normalizeSlackWorkspaceUrl(value: string | undefined | null): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  let candidate = trimmed;
  if (/^https?:\/\//i.test(candidate)) {
    try {
      const parsed = new URL(candidate);
      candidate = parsed.host || "";
    } catch {
      candidate = candidate.replace(/^https?:\/\//i, "");
    }
  }

  candidate = candidate.replace(/\/.*$/, "");
  if (!candidate) {
    return null;
  }

  if (!candidate.includes(".")) {
    candidate = `${candidate}.slack.com`;
  }

  return `https://${candidate}`;
}
