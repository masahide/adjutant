import { configureSandbox } from "../assistant/agent-session-factory.js";

import { resolveSandboxConfig } from "./config.js";
import {
  checkDockerAvailability,
  createDockerCommandRunner,
  ensureDockerImage,
  type DockerCommandRunner,
} from "./docker.js";
import type { SandboxConfig, SandboxRunSpec } from "./types.js";

export interface SandboxRuntime {
  mode: SandboxConfig["mode"];
  enabled: boolean;
  runSpec?: SandboxRunSpec;
  dispose: () => Promise<void>;
}

export async function initializeSandboxRuntime(params: {
  workspaceDir: string;
  env?: NodeJS.ProcessEnv;
  runner?: DockerCommandRunner;
}): Promise<SandboxRuntime> {
  const env = params.env ?? process.env;
  const config = resolveSandboxConfig(env);
  const runner = params.runner ?? createDockerCommandRunner();

  if (config.mode === "off") {
    configureSandbox(null);
    return {
      mode: "off",
      enabled: false,
      dispose: async () => {
        configureSandbox(null);
      },
    };
  }

  const availability = await checkDockerAvailability({ runner });
  if (!availability.available) {
    throw new Error(`sandbox unavailable: ${availability.reason ?? "docker daemon unavailable"}`);
  }

  await ensureDockerImage(config.docker.image, {
    runner,
    autoBuild: config.docker.autoBuildImage,
    buildContextDir: params.workspaceDir,
    dockerfilePath: "Dockerfile.sandbox",
  });

  const runSpec: SandboxRunSpec = {
    image: config.docker.image,
    hostWorkspaceDir: params.workspaceDir,
    containerWorkdir: config.docker.workdir,
    containerHome: config.docker.home,
    user: config.docker.user,
    envAllowlist: config.docker.envAllowlist,
    readOnlyRoot: config.docker.readOnlyRoot,
    tmpfs: config.docker.tmpfs,
    network: config.docker.network,
    capDrop: config.docker.capDrop,
    pidsLimit: config.docker.pidsLimit,
    memory: config.docker.memory,
  };

  configureSandbox({
    mode: config.mode,
    runSpec,
  });

  return {
    mode: config.mode,
    enabled: true,
    runSpec,
    dispose: async () => {
      configureSandbox(null);
    },
  };
}
