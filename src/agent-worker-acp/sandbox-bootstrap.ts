import type { ActiveSandboxConfig, SandboxMode } from "../sandbox/types.js";

const DEFAULT_CONTAINER_WORKDIR = "/workspace";

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

function buildActiveSandboxConfig(env: NodeJS.ProcessEnv, cwd: string): ActiveSandboxConfig | null {
  const mode = parseSandboxMode(env.ACP_WORKER_SANDBOX_MODE);
  if (mode === "off") {
    return null;
  }

  const containerName = env.ACP_WORKER_SANDBOX_CONTAINER_NAME?.trim();
  if (containerName === undefined || containerName.length === 0) {
    return null;
  }
  const workdir = parseOptionalTrimmed(env.ACP_WORKER_SANDBOX_WORKDIR) ?? DEFAULT_CONTAINER_WORKDIR;
  const hostWorkspaceDir = parseOptionalTrimmed(env.ACP_WORKER_SANDBOX_HOST_WORKSPACE_DIR) ?? cwd;
  const envAllowlist = parseCsv(env.ACP_WORKER_SANDBOX_ENV_ALLOWLIST);

  return {
    mode,
    containerName,
    workdir,
    hostWorkspaceDir,
    envAllowlist,
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
