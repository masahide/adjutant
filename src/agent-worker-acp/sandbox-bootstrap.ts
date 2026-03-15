import type { ActiveSandboxConfig, SandboxMode } from "../sandbox/types.js";
import {
  buildSandboxTmpfs,
  DEFAULT_SANDBOX_CAP_DROP,
  DEFAULT_SANDBOX_NETWORK,
  parseBooleanEnv,
  parseCsvEnv,
  parseOptionalTrimmedString,
  parsePositiveIntEnv,
  parseWorkerSandboxMode,
  resolveSandboxHome,
  resolveSandboxWorkdir,
  resolveSandboxUser,
} from "../sandbox/config-helpers.js";

function parseStructuredStringListEnv(value: string | undefined): string[] {
  const normalized = parseOptionalTrimmedString(value);
  if (normalized === undefined) {
    return [];
  }
  if (normalized.startsWith("[")) {
    try {
      const parsed = JSON.parse(normalized) as unknown;
      if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")) {
        return parsed;
      }
    } catch {
      // Fall back to the legacy CSV parser below.
    }
  }
  return parseCsvEnv(normalized);
}

function buildActiveSandboxConfig(env: NodeJS.ProcessEnv, cwd: string): ActiveSandboxConfig | null {
  const mode = parseWorkerSandboxMode(env.ACP_WORKER_SANDBOX_MODE);
  if (mode === "off") {
    return null;
  }

  const image = parseOptionalTrimmedString(env.ACP_WORKER_SANDBOX_IMAGE);
  if (image === undefined) {
    return null;
  }

  const hostWorkspaceDir =
    parseOptionalTrimmedString(env.ACP_WORKER_SANDBOX_HOST_WORKSPACE_DIR) ?? cwd;
  const containerWorkdir = resolveSandboxWorkdir(env.ACP_WORKER_SANDBOX_WORKDIR);
  const containerHome = resolveSandboxHome(env.ACP_WORKER_SANDBOX_HOME);
  const user = resolveSandboxUser(env.ACP_WORKER_SANDBOX_USER);
  const envAllowlist = parseCsvEnv(env.ACP_WORKER_SANDBOX_ENV_ALLOWLIST);
  const tmpfs = parseStructuredStringListEnv(env.ACP_WORKER_SANDBOX_TMPFS);
  const capDrop = parseCsvEnv(env.ACP_WORKER_SANDBOX_CAP_DROP);

  return {
    mode,
    runSpec: {
      image,
      hostWorkspaceDir,
      containerWorkdir,
      containerHome,
      user,
      envAllowlist,
      readOnlyRoot: parseBooleanEnv(env.ACP_WORKER_SANDBOX_READ_ONLY_ROOT, true),
      tmpfs: tmpfs.length > 0 ? tmpfs : buildSandboxTmpfs(containerHome, user),
      network:
        parseOptionalTrimmedString(env.ACP_WORKER_SANDBOX_NETWORK) ?? DEFAULT_SANDBOX_NETWORK,
      capDrop: capDrop.length > 0 ? capDrop : DEFAULT_SANDBOX_CAP_DROP,
      pidsLimit: parsePositiveIntEnv(env.ACP_WORKER_SANDBOX_PIDS_LIMIT),
      memory: parseOptionalTrimmedString(env.ACP_WORKER_SANDBOX_MEMORY),
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
      mode: parseWorkerSandboxMode(env.ACP_WORKER_SANDBOX_MODE),
    };
  }

  const { configureSandbox } = await import("../assistant/agent-session-factory.js");
  configureSandbox(active);
  return {
    enabled: true,
    mode: active.mode,
  };
}
