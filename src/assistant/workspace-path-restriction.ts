import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { homedir } from "node:os";

const WORKSPACE_PATH_NOT_ALLOWED_ERROR = "tool path is not allowed";

function toAbsolutePath(rawPath: string, workspaceDir: string): string {
  const normalizedRaw = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
  const expanded =
    normalizedRaw === "~"
      ? homedir()
      : normalizedRaw.startsWith("~/")
        ? `${homedir()}${normalizedRaw.slice(1)}`
        : normalizedRaw;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(workspaceDir, expanded);
}

function isWithin(basePath: string, targetPath: string): boolean {
  return (
    targetPath === basePath ||
    targetPath.startsWith(`${basePath}${sep}`) ||
    targetPath.startsWith(`${basePath}/`)
  );
}

function toRestrictionError(): Error {
  return new Error(WORKSPACE_PATH_NOT_ALLOWED_ERROR);
}

export class WorkspacePathRestriction {
  private readonly workspaceDir: string;
  private readonly workspaceRealpathPromise: Promise<string>;

  constructor(workspaceDir: string) {
    this.workspaceDir = resolve(workspaceDir);
    this.workspaceRealpathPromise = realpath(this.workspaceDir).catch(() => this.workspaceDir);
  }

  async assertAllowedInputPath(rawPath: string): Promise<void> {
    const trimmed = rawPath.trim();
    if (!trimmed) {
      throw toRestrictionError();
    }
    await this.assertAllowedAbsolutePath(toAbsolutePath(trimmed, this.workspaceDir));
  }

  async assertAllowedAbsolutePath(absolutePath: string): Promise<void> {
    const workspaceRealpath = await this.workspaceRealpathPromise;
    const existingPath = await this.findNearestExistingPath(absolutePath);
    const existingRealpath = await realpath(existingPath).catch(() => null);
    if (!existingRealpath || !isWithin(workspaceRealpath, existingRealpath)) {
      throw toRestrictionError();
    }
  }

  private async findNearestExistingPath(absolutePath: string): Promise<string> {
    let candidate = absolutePath;
    while (true) {
      try {
        await lstat(candidate);
        return candidate;
      } catch (error) {
        const errno = error as NodeJS.ErrnoException;
        if (errno.code !== "ENOENT") {
          throw toRestrictionError();
        }
        const parent = dirname(candidate);
        if (parent === candidate) {
          throw toRestrictionError();
        }
        candidate = parent;
      }
    }
  }
}

export function getWorkspacePathNotAllowedMessage(): string {
  return WORKSPACE_PATH_NOT_ALLOWED_ERROR;
}
