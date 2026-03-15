import {
  buildSandboxTmpfs,
  DEFAULT_SANDBOX_CAP_DROP,
  DEFAULT_SANDBOX_CONTAINER_PREFIX,
  DEFAULT_SANDBOX_IMAGE,
  DEFAULT_SANDBOX_NETWORK,
  DEFAULT_SANDBOX_WORKDIR,
  parseSandboxMode,
  resolveSandboxHome,
  resolveSandboxUser,
} from "./config-helpers.js";
import type { SandboxConfig } from "./types.js";

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true") {
    return true;
  }
  if (normalized === "0" || normalized === "false") {
    return false;
  }
  return fallback;
}

function parseString(value: string | undefined, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : fallback;
}

function parseOptionalString(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function parsePositiveInt(value: string | undefined, fallback: number): number | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseCsvList(value: string | undefined): string[] {
  if (typeof value !== "string" || value.trim().length === 0) {
    return [];
  }
  const uniq = new Set<string>();
  for (const part of value.split(",")) {
    const key = part.trim();
    if (key.length > 0) {
      uniq.add(key);
    }
  }
  return [...uniq];
}

export function resolveSandboxConfig(env: NodeJS.ProcessEnv = process.env): SandboxConfig {
  const user = resolveSandboxUser(env.ADJUTANT_SANDBOX_USER);
  const home = resolveSandboxHome(env.ADJUTANT_SANDBOX_HOME);

  return {
    mode: parseSandboxMode(env.ADJUTANT_SANDBOX_MODE),
    docker: {
      image: parseString(env.ADJUTANT_SANDBOX_IMAGE, DEFAULT_SANDBOX_IMAGE),
      autoBuildImage: parseBoolean(env.ADJUTANT_SANDBOX_AUTO_BUILD_IMAGE, true),
      containerPrefix: parseString(
        env.ADJUTANT_SANDBOX_CONTAINER_PREFIX,
        DEFAULT_SANDBOX_CONTAINER_PREFIX
      ),
      workdir: parseString(env.ADJUTANT_SANDBOX_WORKDIR, DEFAULT_SANDBOX_WORKDIR),
      home,
      user,
      envAllowlist: parseCsvList(env.ADJUTANT_SANDBOX_ENV_ALLOWLIST),
      readOnlyRoot: true,
      tmpfs: buildSandboxTmpfs(home, user),
      network: parseOptionalString(env.ADJUTANT_SANDBOX_NETWORK) ?? DEFAULT_SANDBOX_NETWORK,
      capDrop: DEFAULT_SANDBOX_CAP_DROP,
      pidsLimit: parsePositiveInt(env.ADJUTANT_SANDBOX_PIDS_LIMIT, 256),
      memory: parseOptionalString(env.ADJUTANT_SANDBOX_MEMORY),
    },
  };
}
