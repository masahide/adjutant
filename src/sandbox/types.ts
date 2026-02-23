export type SandboxMode = "off" | "non-main" | "all";

export type SandboxDockerConfig = {
  image: string;
  containerPrefix: string;
  workdir: string;
  readOnlyRoot: boolean;
  tmpfs: string[];
  network: string | undefined;
  capDrop: string[];
  pidsLimit: number | undefined;
  memory: string | undefined;
};

export type SandboxConfig = {
  mode: SandboxMode;
  docker: SandboxDockerConfig;
};
