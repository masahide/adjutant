import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { homedir } from "node:os";

const TOOL_PATH_NOT_ALLOWED_ERROR = "tool path is not allowed";

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

function toToolPathError(): Error {
  return new Error(TOOL_PATH_NOT_ALLOWED_ERROR);
}

export class ToolPathGuard {
  private readonly workspaceDir: string;
  private readonly workspaceRealpathPromise: Promise<string>;

  constructor(workspaceDir: string) {
    this.workspaceDir = resolve(workspaceDir);
    this.workspaceRealpathPromise = realpath(this.workspaceDir).catch(() => this.workspaceDir);
  }

  async assertAllowedInputPath(rawPath: string): Promise<void> {
    const trimmed = rawPath.trim();
    if (!trimmed) {
      throw toToolPathError();
    }
    const absolutePath = toAbsolutePath(trimmed, this.workspaceDir);
    await this.assertAllowedAbsolutePath(absolutePath);
  }

  private async assertAllowedAbsolutePath(absolutePath: string): Promise<void> {
    const workspaceRealpath = await this.workspaceRealpathPromise;
    const existingPath = await this.findNearestExistingPath(absolutePath);
    const existingRealpath = await realpath(existingPath).catch(() => null);
    if (!existingRealpath || !isWithin(workspaceRealpath, existingRealpath)) {
      throw toToolPathError();
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
          throw toToolPathError();
        }
        const parent = dirname(candidate);
        if (parent === candidate) {
          throw toToolPathError();
        }
        candidate = parent;
      }
    }
  }
}

export function getToolPathNotAllowedErrorMessage(): string {
  return TOOL_PATH_NOT_ALLOWED_ERROR;
}
