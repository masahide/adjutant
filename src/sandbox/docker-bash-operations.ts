import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type { BashOperations } from "@mariozechner/pi-coding-agent";

import { createPathMapper } from "./path-mapper.js";
import type { SandboxMode } from "./types.js";

type SpawnLike = (
  command: string,
  args: readonly string[],
  options: {
    stdio: ["ignore", "pipe", "pipe"];
  }
) => ChildProcessWithoutNullStreams;

type DockerExecEnvironment = NodeJS.ProcessEnv | Record<string, string> | undefined;
const DEFAULT_SANDBOX_ENV_ALLOWLIST = ["LANG", "LC_ALL", "TERM", "TZ"] as const;

function normalizeEnvironment(env: DockerExecEnvironment): Record<string, string> {
  const result: Record<string, string> = {};
  if (env === undefined) {
    return result;
  }
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") {
      result[key] = value;
    }
  }
  return result;
}

function resolveEnvAllowlist(customAllowlist: readonly string[] | undefined): Set<string> {
  const resolved = new Set<string>(DEFAULT_SANDBOX_ENV_ALLOWLIST);
  for (const key of customAllowlist ?? []) {
    const normalized = key.trim();
    if (normalized.length > 0) {
      resolved.add(normalized);
    }
  }
  return resolved;
}

export function buildDockerExecArgs(params: {
  containerName: string;
  containerCwd: string;
  command: string;
  env?: DockerExecEnvironment;
  envAllowlist?: readonly string[];
}): string[] {
  const args = ["exec", "-i", "-w", params.containerCwd];
  const envAllowlist = resolveEnvAllowlist(params.envAllowlist);
  const env = normalizeEnvironment(params.env);
  for (const [key, value] of Object.entries(env)) {
    if (!envAllowlist.has(key)) {
      continue;
    }
    args.push("-e", `${key}=${value}`);
  }
  args.push(params.containerName, "bash", "-lc", params.command);
  return args;
}

export function shouldSandbox(
  mode: SandboxMode,
  memoryScope: "main" | "spoke" | undefined
): boolean {
  if (mode === "all") {
    return true;
  }
  if (mode === "non-main") {
    return memoryScope !== "main";
  }
  return false;
}

export interface DockerBashOperationsOptions {
  containerName: string;
  hostWorkspaceDir: string;
  containerWorkdir: string;
  envAllowlist?: string[];
  dockerBin?: string;
  spawnImpl?: SpawnLike;
}

export function createDockerBashOperations(options: DockerBashOperationsOptions): BashOperations {
  const mapper = createPathMapper({
    hostWorkspaceDir: options.hostWorkspaceDir,
    containerWorkdir: options.containerWorkdir,
  });
  const dockerBin = options.dockerBin ?? "docker";
  const spawnImpl = options.spawnImpl ?? spawn;

  return {
    exec: async (command, cwd, params) => {
      if (params.signal?.aborted === true) {
        throw new Error("aborted");
      }
      const containerCwd = mapper.hostToContainer(cwd);
      const args = buildDockerExecArgs({
        containerName: options.containerName,
        containerCwd,
        command,
        env: params.env,
        envAllowlist: options.envAllowlist,
      });

      return await new Promise<{ exitCode: number | null }>((resolveExec, rejectExec) => {
        const child = spawnImpl(dockerBin, args, {
          stdio: ["ignore", "pipe", "pipe"],
        });
        let timedOut = false;
        let timeoutHandle: NodeJS.Timeout | undefined;

        const killChild = () => {
          child.kill("SIGKILL");
        };

        if (typeof params.timeout === "number" && params.timeout > 0) {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            killChild();
          }, params.timeout * 1000);
        }

        child.stdout.on("data", params.onData);
        child.stderr.on("data", params.onData);

        const onAbort = () => {
          killChild();
        };
        params.signal?.addEventListener("abort", onAbort, { once: true });

        child.on("error", (error) => {
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
          }
          params.signal?.removeEventListener("abort", onAbort);
          rejectExec(error);
        });

        child.on("close", (code) => {
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
          }
          params.signal?.removeEventListener("abort", onAbort);
          if (params.signal?.aborted === true) {
            rejectExec(new Error("aborted"));
            return;
          }
          if (timedOut) {
            rejectExec(new Error(`timeout:${String(params.timeout)}`));
            return;
          }
          resolveExec({ exitCode: code });
        });
      });
    },
  };
}
