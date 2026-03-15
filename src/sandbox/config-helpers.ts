import type { SandboxMode } from "./types.js";

export const DEFAULT_SANDBOX_IMAGE = "adjutant-sandbox:trixie-slim";
export const DEFAULT_SANDBOX_CONTAINER_PREFIX = "adjutant-sandbox";
export const DEFAULT_SANDBOX_WORKDIR = "/workspace";
export const DEFAULT_SANDBOX_HOME = "/home/agent";
export const DEFAULT_SANDBOX_NETWORK = "none";
export const DEFAULT_SANDBOX_CAP_DROP = ["ALL"];

export function parseSandboxMode(value: string | undefined): SandboxMode {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return "all";
  }
  if (normalized === "off" || normalized === "non-main" || normalized === "all") {
    return normalized;
  }
  return "off";
}

export function resolveSandboxUser(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized) {
    return resolveDefaultSandboxUser();
  }
  if (!/^\d+:\d+$/.test(normalized)) {
    throw new Error(`invalid sandbox user: ${normalized}`);
  }
  return normalized;
}

export function resolveSandboxHome(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized) {
    return DEFAULT_SANDBOX_HOME;
  }
  if (!normalized.startsWith("/")) {
    throw new Error(`sandbox home must be absolute: ${normalized}`);
  }
  return normalized;
}

export function buildSandboxTmpfs(home: string, user: string): string[] {
  const [uid, gid] = user.split(":");
  if (uid === undefined || gid === undefined) {
    throw new Error(`invalid sandbox user: ${user}`);
  }
  return [
    "/tmp:rw,noexec,nosuid,size=256m,mode=1777",
    "/run:rw,noexec,nosuid,size=64m,mode=755",
    `${home}:rw,exec,nosuid,size=512m,uid=${uid},gid=${gid},mode=700`,
  ];
}

function resolveDefaultSandboxUser(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
  const gid = typeof process.getgid === "function" ? process.getgid() : 1000;
  return `${uid}:${gid}`;
}
