import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { SandboxDockerConfig } from "./types.js";

const SANDBOX_LABEL = "adjutant.sandbox";
const SANDBOX_OWNER_LABEL = "adjutant.sandbox.owner";
const SANDBOX_USER = "1000:1000";

type SpawnLike = (
  command: string,
  args: readonly string[],
  options: {
    stdio: ["ignore", "pipe", "pipe"];
  }
) => ChildProcessWithoutNullStreams;

export type DockerCommandResult = {
  stdout: string;
  stderr: string;
  code: number;
};

export type DockerCommandRunner = (
  args: string[],
  options?: { allowFailure?: boolean }
) => Promise<DockerCommandResult>;

export type DockerAvailability = {
  available: boolean;
  reason?: string;
};

type DockerInspectPayload = Array<{
  Config?: {
    Labels?: Record<string, string>;
  };
  State?: {
    Running?: boolean;
  };
}>;

type ContainerInspectState = {
  exists: boolean;
  running: boolean;
  owner: string | undefined;
};

export function createDockerCommandRunner(params?: { spawnImpl?: SpawnLike }): DockerCommandRunner {
  const spawnImpl = params?.spawnImpl ?? spawn;
  return async (args, options) => {
    return await new Promise<DockerCommandResult>((resolveResult, rejectResult) => {
      const child = spawnImpl("docker", args, {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("error", (error) => {
        rejectResult(error);
      });
      child.on("close", (code) => {
        const exitCode = code ?? 0;
        if (exitCode !== 0 && !options?.allowFailure) {
          const reason = stderr.trim() || `docker ${args.join(" ")} failed`;
          rejectResult(new Error(reason));
          return;
        }
        resolveResult({
          stdout,
          stderr,
          code: exitCode,
        });
      });
    });
  };
}

function defaultRunner(): DockerCommandRunner {
  return createDockerCommandRunner();
}

function parseOptionalLimit(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function parseInspectState(output: string): ContainerInspectState {
  let parsed: DockerInspectPayload;
  try {
    parsed = JSON.parse(output) as DockerInspectPayload;
  } catch {
    throw new Error("failed to parse docker inspect output");
  }
  const item = parsed[0];
  if (!item) {
    return { exists: false, running: false, owner: undefined };
  }
  const labels = item.Config?.Labels ?? {};
  const owner =
    typeof labels[SANDBOX_OWNER_LABEL] === "string" ? labels[SANDBOX_OWNER_LABEL] : undefined;
  return {
    exists: true,
    running: item.State?.Running === true,
    owner,
  };
}

function isNotFoundError(stderr: string): boolean {
  const message = stderr.toLowerCase();
  return message.includes("no such object") || message.includes("no such container");
}

async function inspectContainer(
  containerName: string,
  runner: DockerCommandRunner
): Promise<ContainerInspectState> {
  const result = await runner(["inspect", "--type", "container", containerName], {
    allowFailure: true,
  });
  if (result.code !== 0) {
    if (isNotFoundError(result.stderr)) {
      return { exists: false, running: false, owner: undefined };
    }
    throw new Error(result.stderr.trim() || `failed to inspect container: ${containerName}`);
  }
  return parseInspectState(result.stdout);
}

export function buildSandboxContainerName(params: {
  containerPrefix: string;
  ownerNonce: string;
}): string {
  const prefix = params.containerPrefix.trim() || "adjutant-sandbox";
  return `${prefix}-${params.ownerNonce}`;
}

export function buildSandboxCreateArgs(params: {
  name: string;
  ownerNonce: string;
  cfg: SandboxDockerConfig;
  hostWorkspaceDir: string;
}): string[] {
  const args = ["create", "--name", params.name];
  args.push("--label", `${SANDBOX_LABEL}=1`);
  args.push("--label", `${SANDBOX_OWNER_LABEL}=${params.ownerNonce}`);
  if (params.cfg.readOnlyRoot) {
    args.push("--read-only");
  }
  for (const entry of params.cfg.tmpfs) {
    args.push("--tmpfs", entry);
  }
  if (params.cfg.network) {
    args.push("--network", params.cfg.network);
  }
  for (const cap of params.cfg.capDrop) {
    args.push("--cap-drop", cap);
  }
  args.push("--security-opt", "no-new-privileges");
  if (typeof params.cfg.pidsLimit === "number" && params.cfg.pidsLimit > 0) {
    args.push("--pids-limit", String(params.cfg.pidsLimit));
  }
  const memoryLimit = parseOptionalLimit(params.cfg.memory);
  if (memoryLimit) {
    args.push("--memory", memoryLimit);
  }
  args.push("--user", SANDBOX_USER);
  args.push("--workdir", params.cfg.workdir);
  args.push("-v", `${resolve(params.hostWorkspaceDir)}:${params.cfg.workdir}`);
  args.push(params.cfg.image, "sleep", "infinity");
  return args;
}

export async function isDockerAvailable(params?: {
  runner?: DockerCommandRunner;
}): Promise<boolean> {
  const status = await checkDockerAvailability(params);
  return status.available;
}

export async function checkDockerAvailability(params?: {
  runner?: DockerCommandRunner;
}): Promise<DockerAvailability> {
  const runner = params?.runner ?? defaultRunner();
  try {
    const result = await runner(["version", "--format", "{{.Server.Version}}"], {
      allowFailure: true,
    });
    if (result.code === 0) {
      return { available: true };
    }
    const reason = result.stderr.trim() || result.stdout.trim() || "docker daemon unavailable";
    return { available: false, reason };
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function ensureDockerImage(
  image: string,
  params?: {
    runner?: DockerCommandRunner;
    autoBuild?: boolean;
    buildContextDir?: string;
    dockerfilePath?: string;
  }
): Promise<void> {
  const runner = params?.runner ?? defaultRunner();
  const autoBuild = params?.autoBuild ?? true;
  const result = await runner(["image", "inspect", image], {
    allowFailure: true,
  });
  if (result.code === 0) {
    return;
  }
  if (!autoBuild) {
    throw new Error(`sandbox image not found: ${image}. Run "pnpm sandbox:build" first.`);
  }

  const contextDir = resolve(params?.buildContextDir ?? process.cwd());
  const dockerfilePath = resolve(contextDir, params?.dockerfilePath ?? "Dockerfile.sandbox");
  const buildResult = await runner(["build", "-f", dockerfilePath, "-t", image, contextDir], {
    allowFailure: true,
  });
  if (buildResult.code === 0) {
    return;
  }
  const reason = buildResult.stderr.trim() || buildResult.stdout.trim() || "docker build failed";
  throw new Error(`sandbox image not found: ${image}. auto-build failed: ${reason}`);
}

export async function ensureSandboxContainer(params: {
  cfg: SandboxDockerConfig;
  hostWorkspaceDir: string;
  ownerNonce: string;
  containerName?: string;
  runner?: DockerCommandRunner;
}): Promise<string> {
  const runner = params.runner ?? defaultRunner();
  const hostWorkspaceDir = resolve(params.hostWorkspaceDir);
  await mkdir(hostWorkspaceDir, { recursive: true });
  const containerName =
    params.containerName ??
    buildSandboxContainerName({
      containerPrefix: params.cfg.containerPrefix,
      ownerNonce: params.ownerNonce,
    });
  const state = await inspectContainer(containerName, runner);
  if (!state.exists) {
    const createArgs = buildSandboxCreateArgs({
      name: containerName,
      ownerNonce: params.ownerNonce,
      cfg: params.cfg,
      hostWorkspaceDir,
    });
    await runner(createArgs);
    await runner(["start", containerName]);
    return containerName;
  }

  if (state.owner !== params.ownerNonce) {
    throw new Error(
      `sandbox container owner mismatch: name=${containerName} expected=${params.ownerNonce} actual=${state.owner ?? "unknown"}`
    );
  }

  if (!state.running) {
    await runner(["start", containerName]);
  }
  return containerName;
}

export async function destroySandboxContainer(params: {
  containerName: string;
  ownerNonce: string;
  runner?: DockerCommandRunner;
}): Promise<{ removed: boolean; reason?: "not-found" | "owner-mismatch" }> {
  const runner = params.runner ?? defaultRunner();
  const state = await inspectContainer(params.containerName, runner);
  if (!state.exists) {
    return { removed: false, reason: "not-found" };
  }
  if (state.owner !== params.ownerNonce) {
    return { removed: false, reason: "owner-mismatch" };
  }
  await runner(["rm", "-f", params.containerName]);
  return { removed: true };
}
