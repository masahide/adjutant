import type { ActiveSandboxConfig, SandboxMode } from "../sandbox/types.js";

const DEFAULT_CONTAINER_WORKDIR = "/workspace";
const DEFAULT_SANDBOX_TMPFS = ["/tmp", "/var/tmp", "/run"];
const DEFAULT_SANDBOX_CAP_DROP = ["ALL"];

function parseSandboxMode(value: string | undefined): SandboxMode {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "off" || normalized === "non-main" || normalized === "all") {
    return normalized;
  }
  return "off";
}

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
    parseOptionalTrimmed(env.ACP_WORKER_SANDBOX_WORKDIR) ?? DEFAULT_CONTAINER_WORKDIR;
  const envAllowlist = parseCsv(env.ACP_WORKER_SANDBOX_ENV_ALLOWLIST);
  const tmpfs = parseCsv(env.ACP_WORKER_SANDBOX_TMPFS);
  const capDrop = parseCsv(env.ACP_WORKER_SANDBOX_CAP_DROP);

  return {
    mode,
    runSpec: {
      image,
      hostWorkspaceDir,
      containerWorkdir,
      envAllowlist,
      readOnlyRoot: parseBoolean(env.ACP_WORKER_SANDBOX_READ_ONLY_ROOT, true),
      tmpfs: tmpfs.length > 0 ? tmpfs : DEFAULT_SANDBOX_TMPFS,
      network: parseOptionalTrimmed(env.ACP_WORKER_SANDBOX_NETWORK),
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
