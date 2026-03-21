import {
  DefaultResourceLoader,
  type ResourceDiagnostic,
  type SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { homedir } from "node:os";
import { resolve } from "node:path";

export interface BuildAdditionalSkillPathsOptions {
  projectRoot?: string;
  homedirPath?: string;
}

export interface CreatePiResourceLoaderOptions extends BuildAdditionalSkillPathsOptions {
  workspaceDir: string;
  settingsManager: SettingsManager;
  agentDir?: string;
}

export type SkillWarningLogger = (message: string) => void;

export function buildAdditionalSkillPaths(
  options: BuildAdditionalSkillPathsOptions = {}
): string[] {
  const resolvedPaths: string[] = [];

  const projectRoot = options.projectRoot?.trim();
  if (projectRoot !== undefined && projectRoot.length > 0) {
    resolvedPaths.push(resolve(projectRoot, ".agents/skills"));
  }

  const homeRoot = options.homedirPath?.trim() || homedir();
  if (homeRoot.length > 0) {
    resolvedPaths.push(resolve(homeRoot, ".agents/skills"));
  }

  return Array.from(new Set(resolvedPaths));
}

export function createPiResourceLoader(
  options: CreatePiResourceLoaderOptions
): DefaultResourceLoader {
  return new DefaultResourceLoader({
    cwd: options.workspaceDir,
    agentDir: options.agentDir,
    settingsManager: options.settingsManager,
    additionalSkillPaths: buildAdditionalSkillPaths({
      projectRoot: options.projectRoot,
      homedirPath: options.homedirPath,
    }),
  });
}

export function logSkillDiagnostics(
  diagnostics: ResourceDiagnostic[],
  warn: SkillWarningLogger = (message) => {
    console.warn(message);
  }
): void {
  for (const diagnostic of diagnostics) {
    if (diagnostic.type === "warning" && diagnostic.message === "skill path does not exist") {
      continue;
    }
    const location = diagnostic.path ? ` path=${diagnostic.path}` : "";
    warn(`[pi-skills] ${diagnostic.type}: ${diagnostic.message}${location}`);
  }
}
