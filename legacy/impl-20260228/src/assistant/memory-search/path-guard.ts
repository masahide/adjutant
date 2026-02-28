import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export type ResolvedMemoryPath = {
  relPath: string;
  absPath: string;
};

function normalizeRelPath(value: string): string {
  return value.replaceAll("\\", "/");
}

function isAllowedMemoryPath(relPath: string): boolean {
  const normalized = normalizeRelPath(relPath).replace(/^\.?\//, "");
  if (!normalized) {
    return false;
  }
  if (normalized === "MEMORY.md" || normalized === "memory.md") {
    return true;
  }
  if (!normalized.startsWith("memory/")) {
    return false;
  }
  return normalized.toLowerCase().endsWith(".md");
}

export class MemoryPathGuard {
  private readonly workspaceDir: string;
  private readonly workspaceRealpathPromise: Promise<string>;

  constructor(workspaceDir: string) {
    this.workspaceDir = resolve(workspaceDir);
    this.workspaceRealpathPromise = realpath(this.workspaceDir).catch(() => this.workspaceDir);
  }

  async resolveReadablePath(rawPath: string): Promise<ResolvedMemoryPath> {
    const trimmed = rawPath.trim();
    if (!trimmed) {
      throw new Error("path required");
    }

    const absPath = isAbsolute(trimmed) ? resolve(trimmed) : resolve(this.workspaceDir, trimmed);
    const relPath = normalizeRelPath(relative(this.workspaceDir, absPath));
    const insideWorkspace = relPath.length > 0 && !relPath.startsWith("..") && !isAbsolute(relPath);
    if (!insideWorkspace || !isAllowedMemoryPath(relPath)) {
      throw new Error("path required");
    }

    if (!relPath.toLowerCase().endsWith(".md")) {
      throw new Error("path required");
    }

    const stat = await lstat(absPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("path required");
    }

    const [workspaceRealpath, fileRealpath] = await Promise.all([
      this.workspaceRealpathPromise,
      realpath(absPath),
    ]);
    const inRealWorkspace =
      fileRealpath === workspaceRealpath ||
      fileRealpath.startsWith(`${workspaceRealpath}${sep}`) ||
      fileRealpath.startsWith(`${workspaceRealpath}/`);
    if (!inRealWorkspace) {
      throw new Error("path required");
    }

    const realRelPath = normalizeRelPath(relative(workspaceRealpath, fileRealpath));
    if (!isAllowedMemoryPath(realRelPath)) {
      throw new Error("path required");
    }

    return {
      relPath: realRelPath,
      absPath: fileRealpath,
    };
  }
}
