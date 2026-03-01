import { randomUUID } from "node:crypto";

import { configureSandbox } from "../assistant/agent-session-factory.js";

import { resolveSandboxConfig } from "./config.js";
import {
  checkDockerAvailability,
  createDockerCommandRunner,
  destroySandboxContainer,
  ensureDockerImage,
  ensureSandboxContainer,
  type DockerCommandRunner,
} from "./docker.js";
import type { ActiveSandboxConfig, SandboxConfig } from "./types.js";

export interface SandboxRuntime {
  mode: SandboxConfig["mode"];
  enabled: boolean;
  containerName?: string;
  dispose: () => Promise<void>;
}

export async function initializeSandboxRuntime(params: {
  workspaceDir: string;
  env?: NodeJS.ProcessEnv;
  runner?: DockerCommandRunner;
  ownerNonce?: string;
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

  const ownerNonce = params.ownerNonce ?? randomUUID();
  const containerName = await ensureSandboxContainer({
    cfg: config.docker,
    hostWorkspaceDir: params.workspaceDir,
    ownerNonce,
    runner,
  });

  const activeSandbox: ActiveSandboxConfig = {
    mode: config.mode,
    containerName,
    workdir: config.docker.workdir,
    hostWorkspaceDir: params.workspaceDir,
    envAllowlist: config.docker.envAllowlist,
  };
  configureSandbox(activeSandbox);

  return {
    mode: config.mode,
    enabled: true,
    containerName,
    dispose: async () => {
      await destroySandboxContainer({
        containerName,
        ownerNonce,
        runner,
      });
      configureSandbox(null);
    },
  };
}
