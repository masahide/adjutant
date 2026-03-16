import { access, constants, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type RuntimeDirectories = {
  projectRoot: string;
  stateDir: string;
  workspaceDir: string;
};

export type ResolveRuntimeDirectoriesOptions = {
  env?: NodeJS.ProcessEnv;
  homedirPath?: string;
  projectRoot?: string;
};

export function resolveProjectRootFromMetaUrl(metaUrl: string): string {
  return resolve(dirname(fileURLToPath(metaUrl)), "..", "..");
}

export function resolveStateDir(
  env: NodeJS.ProcessEnv = process.env,
  homedirPath: string = homedir()
): string {
  const stateDirEnv = env.ADJUTANT_STATE_DIR?.trim();
  if (stateDirEnv !== undefined && stateDirEnv.length > 0) {
    return resolve(stateDirEnv);
  }
  return resolve(homedirPath, ".adjutant");
}

export function resolveWorkspaceDir(
  params: {
    env?: NodeJS.ProcessEnv;
    stateDir?: string;
    homedirPath?: string;
  } = {}
): string {
  const env = params.env ?? process.env;
  const workspaceDirEnv = env.ADJUTANT_WORKSPACE_DIR?.trim();
  if (workspaceDirEnv !== undefined && workspaceDirEnv.length > 0) {
    return resolve(workspaceDirEnv);
  }

  const stateDir = params.stateDir ?? resolveStateDir(env, params.homedirPath);
  return resolve(stateDir, "workspace");
}

export function resolveRuntimeDirectories(
  options: ResolveRuntimeDirectoriesOptions = {}
): RuntimeDirectories {
  const projectRoot =
    options.projectRoot !== undefined
      ? resolve(options.projectRoot)
      : resolveProjectRootFromMetaUrl(import.meta.url);
  const stateDir = resolveStateDir(options.env, options.homedirPath);
  const workspaceDir = resolveWorkspaceDir({
    env: options.env,
    stateDir,
    homedirPath: options.homedirPath,
  });

  return {
    projectRoot,
    stateDir,
    workspaceDir,
  };
}

export function resolveWorkspaceTemplateDir(projectRoot: string): string {
  return resolve(projectRoot, "assistant", "prompts");
}

export async function ensureWorkspaceReady(workspaceDir: string): Promise<void> {
  const resolvedWorkspaceDir = workspaceDir.trim();
  if (resolvedWorkspaceDir.length === 0) {
    throw new Error("workspaceDir is required");
  }

  await mkdir(resolvedWorkspaceDir, { recursive: true });
  await access(resolvedWorkspaceDir, constants.W_OK);
}
