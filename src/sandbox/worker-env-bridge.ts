import type { ActiveSandboxConfig } from "./types.js";

const WORKER_SANDBOX_KEYS = [
  "ACP_WORKER_SANDBOX_IMAGE",
  "ACP_WORKER_SANDBOX_HOST_WORKSPACE_DIR",
  "ACP_WORKER_SANDBOX_WORKDIR",
  "ACP_WORKER_SANDBOX_HOME",
  "ACP_WORKER_SANDBOX_USER",
  "ACP_WORKER_SANDBOX_ENV_ALLOWLIST",
  "ACP_WORKER_SANDBOX_READ_ONLY_ROOT",
  "ACP_WORKER_SANDBOX_TMPFS",
  "ACP_WORKER_SANDBOX_CAP_DROP",
  "ACP_WORKER_SANDBOX_NETWORK",
  "ACP_WORKER_SANDBOX_MEMORY",
  "ACP_WORKER_SANDBOX_PIDS_LIMIT",
] as const;

export function applySandboxToWorkerEnv(
  workerEnv: NodeJS.ProcessEnv,
  sandbox:
    | { enabled: true; mode: ActiveSandboxConfig["mode"]; runSpec: ActiveSandboxConfig["runSpec"] }
    | { enabled: false; mode: "off" | "non-main" | "all" }
): NodeJS.ProcessEnv {
  if (sandbox.enabled === false) {
    workerEnv.ACP_WORKER_SANDBOX_MODE = "off";
    clearWorkerSandboxEnv(workerEnv);
    return workerEnv;
  }

  workerEnv.ACP_WORKER_SANDBOX_MODE = sandbox.mode;
  workerEnv.ACP_WORKER_SANDBOX_IMAGE = sandbox.runSpec.image;
  workerEnv.ACP_WORKER_SANDBOX_HOST_WORKSPACE_DIR = sandbox.runSpec.hostWorkspaceDir;
  workerEnv.ACP_WORKER_SANDBOX_WORKDIR = sandbox.runSpec.containerWorkdir;
  workerEnv.ACP_WORKER_SANDBOX_HOME = sandbox.runSpec.containerHome;
  workerEnv.ACP_WORKER_SANDBOX_USER = sandbox.runSpec.user;
  workerEnv.ACP_WORKER_SANDBOX_ENV_ALLOWLIST = (sandbox.runSpec.envAllowlist ?? []).join(",");
  workerEnv.ACP_WORKER_SANDBOX_READ_ONLY_ROOT = sandbox.runSpec.readOnlyRoot === false ? "0" : "1";
  workerEnv.ACP_WORKER_SANDBOX_TMPFS = (sandbox.runSpec.tmpfs ?? []).join(",");
  workerEnv.ACP_WORKER_SANDBOX_CAP_DROP = (sandbox.runSpec.capDrop ?? []).join(",");
  workerEnv.ACP_WORKER_SANDBOX_NETWORK = sandbox.runSpec.network ?? "";
  workerEnv.ACP_WORKER_SANDBOX_MEMORY = sandbox.runSpec.memory ?? "";
  workerEnv.ACP_WORKER_SANDBOX_PIDS_LIMIT =
    typeof sandbox.runSpec.pidsLimit === "number" ? String(sandbox.runSpec.pidsLimit) : "";
  return workerEnv;
}

function clearWorkerSandboxEnv(workerEnv: NodeJS.ProcessEnv): void {
  for (const key of WORKER_SANDBOX_KEYS) {
    delete workerEnv[key];
  }
}
