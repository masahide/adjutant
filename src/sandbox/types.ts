export type SandboxMode = "off" | "non-main" | "all";

export interface SandboxDockerConfig {
  image: string;
  autoBuildImage: boolean;
  containerPrefix: string;
  workdir: string;
  envAllowlist: string[];
  readOnlyRoot: boolean;
  tmpfs: string[];
  network: string | undefined;
  capDrop: string[];
  pidsLimit: number | undefined;
  memory: string | undefined;
}

export interface SandboxConfig {
  mode: SandboxMode;
  docker: SandboxDockerConfig;
}

export interface ActiveSandboxConfig {
  mode: SandboxMode;
  containerName: string;
  workdir: string;
  hostWorkspaceDir: string;
  envAllowlist?: string[];
}
