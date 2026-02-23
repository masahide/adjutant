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

function normalizeEnvironment(env: DockerExecEnvironment): Record<string, string> {
  const result: Record<string, string> = {};
  if (!env) {
    return result;
  }
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") {
      result[key] = value;
    }
  }
  return result;
}

export function buildDockerExecArgs(params: {
  containerName: string;
  containerCwd: string;
  command: string;
  env?: DockerExecEnvironment;
}): string[] {
  const args = ["exec", "-i", "-w", params.containerCwd];
  const env = normalizeEnvironment(params.env);
  for (const [key, value] of Object.entries(env)) {
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

export type DockerBashOperationsOptions = {
  containerName: string;
  hostWorkspaceDir: string;
  containerWorkdir: string;
  dockerBin?: string;
  spawnImpl?: SpawnLike;
};

export function createDockerBashOperations(options: DockerBashOperationsOptions): BashOperations {
  const mapper = createPathMapper({
    hostWorkspaceDir: options.hostWorkspaceDir,
    containerWorkdir: options.containerWorkdir,
  });
  const dockerBin = options.dockerBin ?? "docker";
  const spawnImpl = options.spawnImpl ?? spawn;

  return {
    exec: async (command, cwd, params) => {
      if (params.signal?.aborted) {
        throw new Error("aborted");
      }
      const containerCwd = mapper.hostToContainer(cwd);
      const args = buildDockerExecArgs({
        containerName: options.containerName,
        containerCwd,
        command,
        env: params.env,
      });

      return await new Promise<{ exitCode: number | null }>((resolve, reject) => {
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
          reject(error);
        });

        child.on("close", (code) => {
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
          }
          params.signal?.removeEventListener("abort", onAbort);
          if (params.signal?.aborted) {
            reject(new Error("aborted"));
            return;
          }
          if (timedOut) {
            reject(new Error(`timeout:${String(params.timeout)}`));
            return;
          }
          resolve({ exitCode: code });
        });
      });
    },
  };
}
