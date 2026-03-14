import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const DEFAULT_CDP_HOST = "127.0.0.1";
export const DEFAULT_CDP_PORT = 9222;
export const DEFAULT_CDP_ENDPOINT_FILE = ".adjutant/cdp-endpoint.json";
export const DEFAULT_COLLECTOR_ENTRY = "src/collector-slack/process-rpc-entry.ts";

export type CollectorCdpEndpoint = {
  host: string;
  port: number;
  source: "file" | "env" | "default";
  endpointFilePath: string;
};

export type CollectorSlackConfig = {
  collectorEnabled: boolean;
  collectorEntry: string;
  endpoint: CollectorCdpEndpoint;
  dataDir: string;
  accountId: string;
  workspaceHostsByTeam: Record<string, string>;
  disableDomCapture: boolean;
  debugUiEnabled: boolean;
  debugUiPort: number;
};

type ResolveEndpointOptions = {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  readFile?: (filePath: string, encoding: "utf8") => string;
  exists?: typeof existsSync;
};

type LoadConfigOptions = ResolveEndpointOptions & {
  stateDir?: string;
};

type EndpointFilePayload = {
  host?: unknown;
  port?: unknown;
};

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "1" || normalized === "true") {
    return true;
  }
  if (normalized === "0" || normalized === "false") {
    return false;
  }
  return fallback;
}

function parsePort(raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0 || value > 65535) {
    return undefined;
  }
  return value;
}

function parseWorkspaceHostsByTeam(raw: string | undefined): Record<string, string> {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return {};
  }
  const entries: Record<string, string> = {};
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator <= 0 || separator === trimmed.length - 1) {
      continue;
    }
    const teamId = trimmed.slice(0, separator).trim();
    const host = trimmed
      .slice(separator + 1)
      .trim()
      .replace(/^\/+|\/+$/g, "");
    if (!teamId || !host) {
      continue;
    }
    entries[teamId] = host;
  }
  return entries;
}

function resolveEndpointFilePath(pathValue: string, cwd: string): string {
  if (isAbsolute(pathValue)) {
    return pathValue;
  }
  return resolve(cwd, pathValue);
}

function parseEndpointFilePayload(
  payload: EndpointFilePayload
): { host: string; port: number } | undefined {
  const host = typeof payload.host === "string" ? payload.host.trim() : "";
  const rawPort =
    typeof payload.port === "number"
      ? payload.port
      : typeof payload.port === "string"
        ? Number.parseInt(payload.port, 10)
        : Number.NaN;
  if (!host) {
    return undefined;
  }
  if (!Number.isInteger(rawPort) || rawPort <= 0 || rawPort > 65535) {
    return undefined;
  }
  return { host, port: rawPort };
}

export function resolveCollectorCdpEndpoint(
  options: ResolveEndpointOptions = {}
): CollectorCdpEndpoint {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const readFile =
    options.readFile ?? ((filePath: string, encoding: "utf8") => readFileSync(filePath, encoding));
  const exists = options.exists ?? existsSync;

  const endpointFile = env.CDP_ENDPOINT_FILE?.trim() || DEFAULT_CDP_ENDPOINT_FILE;
  const endpointFilePath = resolveEndpointFilePath(endpointFile, cwd);

  if (exists(endpointFilePath)) {
    try {
      const raw = readFile(endpointFilePath, "utf8");
      const parsed = JSON.parse(raw) as EndpointFilePayload;
      const endpoint = parseEndpointFilePayload(parsed);
      if (endpoint !== undefined) {
        return {
          ...endpoint,
          source: "file",
          endpointFilePath,
        };
      }
    } catch {
      // malformed endpoint file is ignored and falls through to env/default
    }
  }

  const envHost = env.CDP_HOST?.trim();
  const envPort = parsePort(env.CDP_PORT);
  if (envHost && envPort !== undefined) {
    return {
      host: envHost,
      port: envPort,
      source: "env",
      endpointFilePath,
    };
  }

  return {
    host: DEFAULT_CDP_HOST,
    port: DEFAULT_CDP_PORT,
    source: "default",
    endpointFilePath,
  };
}

function resolveStateDir(env: NodeJS.ProcessEnv, providedStateDir?: string): string {
  if (providedStateDir && providedStateDir.trim().length > 0) {
    return resolve(providedStateDir);
  }
  const fromEnv = env.ADJUTANT_STATE_DIR?.trim();
  if (fromEnv && fromEnv.length > 0) {
    return resolve(fromEnv);
  }
  return join(homedir(), ".adjutant");
}

function resolveDataDir(env: NodeJS.ProcessEnv, stateDir: string): string {
  const dataDirRaw = env.ADJUTANT_DATA_DIR?.trim() || env.DATA_DIR?.trim();
  if (dataDirRaw && dataDirRaw.length > 0) {
    return resolve(dataDirRaw);
  }
  return join(stateDir, "data");
}

export function loadCollectorSlackConfig(options: LoadConfigOptions = {}): CollectorSlackConfig {
  const env = options.env ?? process.env;
  const stateDir = resolveStateDir(env, options.stateDir);
  const endpoint = resolveCollectorCdpEndpoint(options);

  const accountId = env.ADJUTANT_SLACK_ACCOUNT_ID?.trim() || "default";
  const debugUiPort = parsePort(env.ADJUTANT_DEBUG_UI_PORT) ?? 8787;

  return {
    collectorEnabled: parseBoolean(env.ADJUTANT_COLLECTOR_SLACK_ENABLED, false),
    collectorEntry: env.ADJUTANT_COLLECTOR_SLACK_ENTRY?.trim() || DEFAULT_COLLECTOR_ENTRY,
    endpoint,
    dataDir: resolveDataDir(env, stateDir),
    accountId,
    workspaceHostsByTeam: parseWorkspaceHostsByTeam(env.ADJUTANT_SLACK_WORKSPACE_HOSTS),
    disableDomCapture: parseBoolean(env.ADJUTANT_DISABLE_DOM_CAPTURE, false),
    debugUiEnabled: parseBoolean(env.ADJUTANT_DEBUG_UI, false),
    debugUiPort,
  };
}
