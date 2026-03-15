import { access, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  resolveProjectRootFromMetaUrl,
  resolveWorkspaceTemplateDir,
} from "../runtime/runtime-directories.js";

export const DEFAULT_AGENTS_FILENAME = "AGENTS.md";
export const DEFAULT_SOUL_FILENAME = "SOUL.md";
export const DEFAULT_TOOLS_FILENAME = "TOOLS.md";
export const DEFAULT_IDENTITY_FILENAME = "IDENTITY.md";
export const DEFAULT_USER_FILENAME = "USER.md";
export const DEFAULT_HEARTBEAT_FILENAME = "HEARTBEAT.md";
export const DEFAULT_BOOTSTRAP_FILENAME = "BOOTSTRAP.md";
export const DEFAULT_MEMORY_FILENAME = "MEMORY.md";
export const DEFAULT_MEMORY_ALT_FILENAME = "memory.md";

const DEFAULT_PROMPT_TEMPLATE_DIR = resolveWorkspaceTemplateDir(
  resolveProjectRootFromMetaUrl(import.meta.url)
);

export type WorkspaceBootstrapFileName =
  | typeof DEFAULT_AGENTS_FILENAME
  | typeof DEFAULT_SOUL_FILENAME
  | typeof DEFAULT_TOOLS_FILENAME
  | typeof DEFAULT_IDENTITY_FILENAME
  | typeof DEFAULT_USER_FILENAME
  | typeof DEFAULT_HEARTBEAT_FILENAME
  | typeof DEFAULT_BOOTSTRAP_FILENAME
  | typeof DEFAULT_MEMORY_FILENAME
  | typeof DEFAULT_MEMORY_ALT_FILENAME;

export type WorkspaceBootstrapFile = {
  name: WorkspaceBootstrapFileName;
  path: string;
  content?: string;
  missing: boolean;
};

export type WorkspaceInitDecision = {
  createdWorkspace: boolean;
  isBrandNewWorkspace: boolean;
  createdFiles: string[];
};

type WorkspaceBootstrapInitOptions = {
  templateDir?: string;
};

const REQUIRED_BOOTSTRAP_FILES: WorkspaceBootstrapFileName[] = [
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_SOUL_FILENAME,
  DEFAULT_TOOLS_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_USER_FILENAME,
  DEFAULT_HEARTBEAT_FILENAME,
];

const OPTIONAL_MEMORY_FILES: WorkspaceBootstrapFileName[] = [
  DEFAULT_MEMORY_FILENAME,
  DEFAULT_MEMORY_ALT_FILENAME,
];

const MAIN_SESSION_BOOTSTRAP_ALLOWLIST: ReadonlySet<WorkspaceBootstrapFileName> = new Set([
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_SOUL_FILENAME,
  DEFAULT_TOOLS_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_USER_FILENAME,
  DEFAULT_HEARTBEAT_FILENAME,
  DEFAULT_BOOTSTRAP_FILENAME,
  DEFAULT_MEMORY_FILENAME,
  DEFAULT_MEMORY_ALT_FILENAME,
]);

function isErrnoCode(error: unknown, code: string): boolean {
  const record = error as NodeJS.ErrnoException;
  return record?.code === code;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function writeFileIfMissing(path: string, content: string): Promise<boolean> {
  try {
    await writeFile(path, content, { encoding: "utf8", flag: "wx" });
    return true;
  } catch (error) {
    if (isErrnoCode(error, "EEXIST")) {
      return false;
    }
    throw error;
  }
}

async function readTemplateFile(
  fileName: WorkspaceBootstrapFileName,
  templateDir?: string
): Promise<string> {
  const resolvedTemplateDir = templateDir?.trim() || DEFAULT_PROMPT_TEMPLATE_DIR;
  const path = join(resolvedTemplateDir, fileName);
  try {
    const content = await readFile(path, "utf8");
    return stripFrontMatter(content);
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) {
      throw new Error(
        `Missing workspace template: ${path} (file=${fileName}, templateDir=${resolvedTemplateDir})`
      );
    }
    throw error;
  }
}

function stripFrontMatter(content: string): string {
  if (!content.startsWith("---")) {
    return content;
  }
  const endIndex = content.indexOf("\n---", 3);
  if (endIndex === -1) {
    return content;
  }
  return content.slice(endIndex + "\n---".length).replace(/^\s+/, "");
}

export async function ensureWorkspaceBootstrapFiles(
  workspaceDir: string,
  options: WorkspaceBootstrapInitOptions = {}
): Promise<WorkspaceInitDecision> {
  const resolvedWorkspaceDir = workspaceDir.trim();
  if (!resolvedWorkspaceDir) {
    throw new Error("workspaceDir is required");
  }

  const createdWorkspace = !(await pathExists(resolvedWorkspaceDir));
  await mkdir(resolvedWorkspaceDir, { recursive: true });

  const requiredFilePaths = REQUIRED_BOOTSTRAP_FILES.map((fileName) =>
    join(resolvedWorkspaceDir, fileName)
  );
  const existingRequiredFileStates = await Promise.all(
    requiredFilePaths.map((path) => pathExists(path))
  );
  const isBrandNewWorkspace = existingRequiredFileStates.every((exists) => !exists);

  const createdFiles: string[] = [];
  for (const fileName of REQUIRED_BOOTSTRAP_FILES) {
    const filePath = join(resolvedWorkspaceDir, fileName);
    if (await pathExists(filePath)) {
      continue;
    }
    const template = await readTemplateFile(fileName, options.templateDir);
    const created = await writeFileIfMissing(filePath, template);
    if (created) {
      createdFiles.push(fileName);
    }
  }

  if (isBrandNewWorkspace) {
    const bootstrapPath = join(resolvedWorkspaceDir, DEFAULT_BOOTSTRAP_FILENAME);
    if (!(await pathExists(bootstrapPath))) {
      const template = await readTemplateFile(DEFAULT_BOOTSTRAP_FILENAME, options.templateDir);
      const created = await writeFileIfMissing(bootstrapPath, template);
      if (created) {
        createdFiles.push(DEFAULT_BOOTSTRAP_FILENAME);
      }
    }
  }

  return {
    createdWorkspace,
    isBrandNewWorkspace,
    createdFiles,
  };
}

async function resolveMemoryBootstrapEntries(
  workspaceDir: string
): Promise<Array<{ name: WorkspaceBootstrapFileName; path: string }>> {
  const entries: Array<{ name: WorkspaceBootstrapFileName; path: string }> = [];
  for (const fileName of OPTIONAL_MEMORY_FILES) {
    const path = join(workspaceDir, fileName);
    if (await pathExists(path)) {
      entries.push({ name: fileName, path });
    }
  }
  if (entries.length <= 1) {
    return entries;
  }

  const deduped: Array<{ name: WorkspaceBootstrapFileName; path: string }> = [];
  const seenRealPaths = new Set<string>();
  for (const entry of entries) {
    let realPathKey = entry.path;
    try {
      realPathKey = await realpath(entry.path);
    } catch {
      // keep original path as fallback key
    }
    if (seenRealPaths.has(realPathKey)) {
      continue;
    }
    seenRealPaths.add(realPathKey);
    deduped.push(entry);
  }
  return deduped;
}

export async function loadWorkspaceBootstrapFiles(
  workspaceDir: string
): Promise<WorkspaceBootstrapFile[]> {
  const resolvedWorkspaceDir = workspaceDir.trim();
  const entries: Array<{ name: WorkspaceBootstrapFileName; path: string }> = [
    ...REQUIRED_BOOTSTRAP_FILES.map((fileName) => ({
      name: fileName,
      path: join(resolvedWorkspaceDir, fileName),
    })),
    {
      name: DEFAULT_BOOTSTRAP_FILENAME,
      path: join(resolvedWorkspaceDir, DEFAULT_BOOTSTRAP_FILENAME),
    },
  ];

  entries.push(...(await resolveMemoryBootstrapEntries(resolvedWorkspaceDir)));

  const files: WorkspaceBootstrapFile[] = [];
  for (const entry of entries) {
    try {
      const content = await readFile(entry.path, "utf8");
      files.push({
        name: entry.name,
        path: entry.path,
        content,
        missing: false,
      });
    } catch (error) {
      if (!isErrnoCode(error, "ENOENT")) {
        console.warn("[WorkspaceBootstrap] file read failed, treating as missing", {
          runId: null,
          sessionKey: null,
          toolCallId: null,
          fileName: entry.name,
          path: entry.path,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      files.push({
        name: entry.name,
        path: entry.path,
        missing: true,
      });
    }
  }

  return files;
}

export function filterBootstrapFilesForMainSession(
  files: WorkspaceBootstrapFile[]
): WorkspaceBootstrapFile[] {
  return files.filter((file) => MAIN_SESSION_BOOTSTRAP_ALLOWLIST.has(file.name));
}
