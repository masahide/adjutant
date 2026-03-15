import type { SandboxMode } from "./types.js";

export const DEFAULT_SANDBOX_IMAGE = "adjutant-sandbox:trixie-slim";
export const DEFAULT_SANDBOX_CONTAINER_PREFIX = "adjutant-sandbox";
export const DEFAULT_SANDBOX_WORKDIR = "/workspace";
export const DEFAULT_SANDBOX_HOME = "/home/agent";
export const DEFAULT_SANDBOX_NETWORK = "bridge";
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

export function parseWorkerSandboxMode(value: string | undefined): SandboxMode {
  if (value?.trim().length === 0 || value === undefined) {
    return "off";
  }
  return parseSandboxMode(value);
}

export function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
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

export function parseTrimmedString(value: string | undefined, fallback: string): string {
  const normalized = parseOptionalTrimmedString(value);
  return normalized ?? fallback;
}

export function parseOptionalTrimmedString(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function parsePositiveIntEnv(
  value: string | undefined,
  fallback?: number
): number | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

export function parseCsvEnv(value: string | undefined): string[] {
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

export function resolveSandboxWorkdir(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized) {
    return DEFAULT_SANDBOX_WORKDIR;
  }
  if (!normalized.startsWith("/")) {
    throw new Error(`sandbox workdir must be absolute: ${normalized}`);
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

export function buildSandboxHardeningArgs(params: {
  readOnlyRoot?: boolean;
  tmpfs?: readonly string[];
  containerHome?: string;
  user?: string;
  network?: string;
  capDrop?: readonly string[];
  pidsLimit?: number;
  memory?: string;
}): string[] {
  const sandboxUser = params.user?.trim() || resolveSandboxUser(undefined);
  const containerHome = params.containerHome?.trim() || DEFAULT_SANDBOX_HOME;
  const args: string[] = [];

  if (params.readOnlyRoot !== false) {
    args.push("--read-only");
  }
  for (const entry of params.tmpfs ?? buildSandboxTmpfs(containerHome, sandboxUser)) {
    args.push("--tmpfs", entry);
  }
  args.push("--network", params.network?.trim() || DEFAULT_SANDBOX_NETWORK);
  for (const cap of params.capDrop ?? DEFAULT_SANDBOX_CAP_DROP) {
    args.push("--cap-drop", cap);
  }
  args.push("--security-opt", "no-new-privileges=true");
  args.push("--security-opt", "seccomp=builtin");
  args.push("--ipc=private", "--cgroupns=private", "--hostname=sandbox");

  if (typeof params.pidsLimit === "number" && params.pidsLimit > 0) {
    args.push("--pids-limit", String(params.pidsLimit));
  }

  const memoryLimit = parseOptionalTrimmedString(params.memory);
  if (memoryLimit !== undefined) {
    args.push("--memory", memoryLimit);
    args.push("--memory-swap", memoryLimit);
  }

  return args;
}

function resolveDefaultSandboxUser(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
  const gid = typeof process.getgid === "function" ? process.getgid() : 1000;
  return `${uid}:${gid}`;
}
