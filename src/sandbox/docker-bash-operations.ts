import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";

import type { BashOperations } from "@mariozechner/pi-coding-agent";

import {
  buildSandboxHardeningArgs,
  DEFAULT_SANDBOX_CAP_DROP,
  DEFAULT_SANDBOX_HOME,
  parseOptionalTrimmedString,
  resolveSandboxUser,
} from "./config-helpers.js";
import { createPathMapper } from "./path-mapper.js";
import type { SandboxMode, SandboxRunSpec } from "./types.js";

type SpawnLike = (
  command: string,
  args: readonly string[],
  options: {
    stdio: ["ignore", "pipe", "pipe"];
  }
) => ChildProcessWithoutNullStreams;

type DockerRunEnvironment = NodeJS.ProcessEnv | Record<string, string> | undefined;
const DEFAULT_SANDBOX_ENV_ALLOWLIST = ["LANG", "LC_ALL", "TERM", "TZ"] as const;

function normalizeEnvironment(env: DockerRunEnvironment): Record<string, string> {
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

export function buildDockerRunArgs(params: {
  runSpec: SandboxRunSpec;
  containerCwd: string;
  command: string;
  env?: DockerRunEnvironment;
}): string[] {
  const args = ["run", "--rm", "-i", "--pull=never", "--init", "--workdir", params.containerCwd];
  const runSpec = params.runSpec;
  const sandboxUser = runSpec.user?.trim() || resolveSandboxUser(undefined);
  const containerHome = runSpec.containerHome?.trim() || DEFAULT_SANDBOX_HOME;

  args.push(
    ...buildSandboxHardeningArgs({
      readOnlyRoot: runSpec.readOnlyRoot,
      tmpfs: runSpec.tmpfs,
      containerHome,
      user: sandboxUser,
      network: runSpec.network,
      capDrop: runSpec.capDrop ?? DEFAULT_SANDBOX_CAP_DROP,
      pidsLimit: runSpec.pidsLimit,
      memory: parseOptionalTrimmedString(runSpec.memory),
    })
  );

  args.push("--user", sandboxUser);
  args.push("-e", `HOME=${containerHome}`);
  args.push(
    "--mount",
    `type=bind,src=${resolve(runSpec.hostWorkspaceDir)},dst=${runSpec.containerWorkdir}`
  );

  const envAllowlist = resolveEnvAllowlist(runSpec.envAllowlist);
  const env = normalizeEnvironment(params.env);
  for (const [key, value] of Object.entries(env)) {
    if (!envAllowlist.has(key) && !key.startsWith("ADJ_")) {
      continue;
    }
    args.push("-e", `${key}=${value}`);
  }

  args.push(runSpec.image, "bash", "-lc", params.command);
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
  runSpec: SandboxRunSpec;
  dockerBin?: string;
  spawnImpl?: SpawnLike;
}

export function createDockerBashOperations(options: DockerBashOperationsOptions): BashOperations {
  const runSpec = options.runSpec;
  const mapper = createPathMapper({
    hostWorkspaceDir: runSpec.hostWorkspaceDir,
    containerWorkdir: runSpec.containerWorkdir,
  });
  const dockerBin = options.dockerBin ?? "docker";
  const spawnImpl = options.spawnImpl ?? spawn;

  return {
    exec: async (command, cwd, params) => {
      if (params.signal?.aborted === true) {
        throw new Error("aborted");
      }
      const containerCwd = mapper.hostToContainer(cwd);
      const args = buildDockerRunArgs({
        runSpec,
        containerCwd,
        command,
        env: params.env,
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
