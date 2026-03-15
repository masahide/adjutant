import type { ActiveSandboxConfig, SandboxMode } from "../sandbox/types.js";
import {
  buildSandboxTmpfs,
  DEFAULT_SANDBOX_CAP_DROP,
  DEFAULT_SANDBOX_HOME,
  DEFAULT_SANDBOX_NETWORK,
  DEFAULT_SANDBOX_WORKDIR,
  parseSandboxMode,
  resolveSandboxHome,
  resolveSandboxUser,
} from "../sandbox/config-helpers.js";

function parseCsv(value: string | undefined): string[] {
  if (typeof value !== "string" || value.trim().length === 0) {
    return [];
  }
  const unique = new Set<string>();
  for (const entry of value.split(",")) {
    const trimmed = entry.trim();
    if (trimmed.length > 0) {
      unique.add(trimmed);
    }
  }
  return [...unique];
}

function parseOptionalTrimmed(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

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

function parsePositiveInt(value: string | undefined): number | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  return parsed;
}

function buildActiveSandboxConfig(env: NodeJS.ProcessEnv, cwd: string): ActiveSandboxConfig | null {
  const mode = parseSandboxMode(env.ACP_WORKER_SANDBOX_MODE);
  if (mode === "off") {
    return null;
  }

  const image = parseOptionalTrimmed(env.ACP_WORKER_SANDBOX_IMAGE);
  if (image === undefined) {
    return null;
  }

  const hostWorkspaceDir = parseOptionalTrimmed(env.ACP_WORKER_SANDBOX_HOST_WORKSPACE_DIR) ?? cwd;
  const containerWorkdir =
    parseOptionalTrimmed(env.ACP_WORKER_SANDBOX_WORKDIR) ?? DEFAULT_SANDBOX_WORKDIR;
  const containerHome = resolveSandboxHome(env.ACP_WORKER_SANDBOX_HOME ?? DEFAULT_SANDBOX_HOME);
  const user = resolveSandboxUser(env.ACP_WORKER_SANDBOX_USER);
  const envAllowlist = parseCsv(env.ACP_WORKER_SANDBOX_ENV_ALLOWLIST);
  const tmpfs = parseCsv(env.ACP_WORKER_SANDBOX_TMPFS);
  const capDrop = parseCsv(env.ACP_WORKER_SANDBOX_CAP_DROP);

  return {
    mode,
    runSpec: {
      image,
      hostWorkspaceDir,
      containerWorkdir,
      containerHome,
      user,
      envAllowlist,
      readOnlyRoot: parseBoolean(env.ACP_WORKER_SANDBOX_READ_ONLY_ROOT, true),
      tmpfs: tmpfs.length > 0 ? tmpfs : buildSandboxTmpfs(containerHome, user),
      network: parseOptionalTrimmed(env.ACP_WORKER_SANDBOX_NETWORK) ?? DEFAULT_SANDBOX_NETWORK,
      capDrop: capDrop.length > 0 ? capDrop : DEFAULT_SANDBOX_CAP_DROP,
      pidsLimit: parsePositiveInt(env.ACP_WORKER_SANDBOX_PIDS_LIMIT),
      memory: parseOptionalTrimmed(env.ACP_WORKER_SANDBOX_MEMORY),
    },
  };
}

export async function configureWorkerSandboxFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd()
): Promise<{ enabled: boolean; mode: SandboxMode }> {
  const active = buildActiveSandboxConfig(env, cwd);
  if (active === null) {
    return {
      enabled: false,
      mode: parseSandboxMode(env.ACP_WORKER_SANDBOX_MODE),
    };
  }

  const { configureSandbox } = await import("../assistant/agent-session-factory.js");
  configureSandbox(active);
  return {
    enabled: true,
    mode: active.mode,
  };
}
