import { parseBooleanEnv, parsePositiveIntEnv, parseStringEnv } from "../runtime/env-parsers.js";
import type { SandboxConfig, SandboxMode } from "./types.js";

const DEFAULT_SANDBOX_IMAGE = "adjutant-sandbox:trixie-slim";
const DEFAULT_SANDBOX_CONTAINER_PREFIX = "adjutant-sandbox";
const DEFAULT_SANDBOX_WORKDIR = "/workspace";
const DEFAULT_SANDBOX_TMPFS = ["/tmp", "/var/tmp", "/run"];
const DEFAULT_SANDBOX_CAP_DROP = ["ALL"];

function parseSandboxMode(value: string | undefined): SandboxMode {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return "all";
  }
  if (normalized === "off" || normalized === "non-main" || normalized === "all") {
    return normalized;
  }
  return "off";
}

function parseOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function parseCsvList(value: string | undefined): string[] {
  const normalized = value?.trim();
  if (!normalized) {
    return [];
  }
  const uniq = new Set<string>();
  for (const entry of normalized.split(",")) {
    const key = entry.trim();
    if (!key) {
      continue;
    }
    uniq.add(key);
  }
  return Array.from(uniq);
}

export function resolveSandboxConfig(env: NodeJS.ProcessEnv = process.env): SandboxConfig {
  return {
    mode: parseSandboxMode(env.ADJUTANT_SANDBOX_MODE),
    docker: {
      image: parseStringEnv(env.ADJUTANT_SANDBOX_IMAGE, DEFAULT_SANDBOX_IMAGE),
      autoBuildImage: parseBooleanEnv(env.ADJUTANT_SANDBOX_AUTO_BUILD_IMAGE, true),
      containerPrefix: parseStringEnv(
        env.ADJUTANT_SANDBOX_CONTAINER_PREFIX,
        DEFAULT_SANDBOX_CONTAINER_PREFIX
      ),
      workdir: parseStringEnv(env.ADJUTANT_SANDBOX_WORKDIR, DEFAULT_SANDBOX_WORKDIR),
      envAllowlist: parseCsvList(env.ADJUTANT_SANDBOX_ENV_ALLOWLIST),
      readOnlyRoot: true,
      tmpfs: DEFAULT_SANDBOX_TMPFS,
      network: parseOptionalString(env.ADJUTANT_SANDBOX_NETWORK),
      capDrop: DEFAULT_SANDBOX_CAP_DROP,
      pidsLimit: parsePositiveIntEnv(env.ADJUTANT_SANDBOX_PIDS_LIMIT, 256),
      memory: parseOptionalString(env.ADJUTANT_SANDBOX_MEMORY),
    },
  };
}
