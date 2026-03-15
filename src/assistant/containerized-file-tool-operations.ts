import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { basename, posix as pathPosix, resolve } from "node:path";

import {
  DEFAULT_MAX_BYTES,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  formatSize,
  truncateHead,
  truncateLine,
  type EditOperations,
  type FindOperations,
  type GrepToolInput,
  type LsOperations,
  type ReadOperations,
  type ToolDefinition,
  type WriteOperations,
} from "@mariozechner/pi-coding-agent";

import { buildDockerRunArgs } from "../sandbox/docker-bash-operations.js";
import { createPathMapper } from "../sandbox/path-mapper.js";
import type { SandboxRunSpec } from "../sandbox/types.js";
import {
  getWorkspacePathNotAllowedMessage,
  WorkspacePathRestriction,
} from "./workspace-path-restriction.js";

type SpawnLike = (
  command: string,
  args: readonly string[],
  options: {
    stdio: ["pipe", "pipe", "pipe"];
  }
) => ChildProcessWithoutNullStreams;

type DockerRunResult = {
  exitCode: number | null;
  stdout: Buffer;
  stderr: Buffer;
};

type ContainerizedFileToolOptions = {
  runSpec: SandboxRunSpec;
  dockerBin?: string;
  spawnImpl?: SpawnLike;
};

type ExecDockerCommandOptions = {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string | Buffer;
  signal?: AbortSignal;
};

type GrepMatch = {
  filePath: string;
  lineNumber: number;
};

const GREP_DEFAULT_LIMIT = 100;
const GREP_MAX_LINE_LENGTH = 500;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function parseBooleanExit(result: DockerRunResult): boolean {
  if (result.exitCode === 0) {
    return true;
  }
  const stderr = result.stderr.toString("utf-8").trim();
  if (result.exitCode === 1 && !stderr) {
    return false;
  }
  throw new Error(stderr || `Command exited with code ${String(result.exitCode)}`);
}

function buildFindCommand(pattern: string): string {
  const args = [
    "rg",
    "--files",
    "--hidden",
    "-g",
    pattern,
    "-g",
    "!**/node_modules/**",
    "-g",
    "!**/.git/**",
    ".",
  ];
  return args.map(shellQuote).join(" ");
}

export class ContainerizedFileToolOperations {
  private readonly runSpec: SandboxRunSpec;
  private readonly dockerBin: string;
  private readonly spawnImpl: SpawnLike;
  private readonly pathMapper;
  private readonly pathRestriction: WorkspacePathRestriction;

  constructor(options: ContainerizedFileToolOptions) {
    this.runSpec = options.runSpec;
    this.dockerBin = options.dockerBin ?? "docker";
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.pathMapper = createPathMapper({
      hostWorkspaceDir: this.runSpec.hostWorkspaceDir,
      containerWorkdir: this.runSpec.containerWorkdir,
    });
    this.pathRestriction = new WorkspacePathRestriction(this.runSpec.hostWorkspaceDir);
  }

  createReadOperations(): ReadOperations {
    return {
      readFile: async (absolutePath) => {
        await this.pathRestriction.assertAllowedAbsolutePath(absolutePath);
        const result = await this.execDockerCommand('cat -- "$ADJ_PATH"', {
          env: { ADJ_PATH: this.toContainerPath(absolutePath) },
        });
        this.assertCommandSucceeded(result);
        return result.stdout;
      },
      access: async (absolutePath) => {
        await this.pathRestriction.assertAllowedAbsolutePath(absolutePath);
        const result = await this.execDockerCommand('[ -r "$ADJ_PATH" ]', {
          env: { ADJ_PATH: this.toContainerPath(absolutePath) },
        });
        if (!parseBooleanExit(result)) {
          throw new Error(`File not found: ${absolutePath}`);
        }
      },
    };
  }

  createWriteOperations(): WriteOperations {
    return {
      mkdir: async (dir) => {
        await this.pathRestriction.assertAllowedAbsolutePath(dir);
        const result = await this.execDockerCommand('mkdir -p -- "$ADJ_DIR"', {
          env: { ADJ_DIR: this.toContainerPath(dir) },
        });
        this.assertCommandSucceeded(result);
      },
      writeFile: async (absolutePath, content) => {
        await this.pathRestriction.assertAllowedAbsolutePath(absolutePath);
        const result = await this.execDockerCommand('cat > "$ADJ_PATH"', {
          env: { ADJ_PATH: this.toContainerPath(absolutePath) },
          stdin: content,
        });
        this.assertCommandSucceeded(result);
      },
    };
  }

  createEditOperations(): EditOperations {
    return {
      readFile: async (absolutePath) => {
        await this.pathRestriction.assertAllowedAbsolutePath(absolutePath);
        const result = await this.execDockerCommand('cat -- "$ADJ_PATH"', {
          env: { ADJ_PATH: this.toContainerPath(absolutePath) },
        });
        this.assertCommandSucceeded(result);
        return result.stdout;
      },
      writeFile: async (absolutePath, content) => {
        await this.pathRestriction.assertAllowedAbsolutePath(absolutePath);
        const result = await this.execDockerCommand('cat > "$ADJ_PATH"', {
          env: { ADJ_PATH: this.toContainerPath(absolutePath) },
          stdin: content,
        });
        this.assertCommandSucceeded(result);
      },
      access: async (absolutePath) => {
        await this.pathRestriction.assertAllowedAbsolutePath(absolutePath);
        const result = await this.execDockerCommand('[ -r "$ADJ_PATH" ] && [ -w "$ADJ_PATH" ]', {
          env: { ADJ_PATH: this.toContainerPath(absolutePath) },
        });
        if (!parseBooleanExit(result)) {
          throw new Error(`File not found: ${absolutePath}`);
        }
      },
    };
  }

  createFindOperations(): FindOperations {
    return {
      exists: async (absolutePath) => {
        await this.pathRestriction.assertAllowedAbsolutePath(absolutePath);
        const result = await this.execDockerCommand('[ -e "$ADJ_PATH" ]', {
          env: { ADJ_PATH: this.toContainerPath(absolutePath) },
        });
        return parseBooleanExit(result);
      },
      glob: async (pattern, searchCwd, options) => {
        await this.pathRestriction.assertAllowedAbsolutePath(searchCwd);
        const result = await this.execDockerCommand(buildFindCommand(pattern), {
          cwd: searchCwd,
        });
        const stderr = result.stderr.toString("utf-8").trim();
        if (result.exitCode !== 0 && result.exitCode !== 1) {
          throw new Error(stderr || `Command exited with code ${String(result.exitCode)}`);
        }
        const lines = result.stdout
          .toString("utf-8")
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
          .filter((line) => !line.startsWith(".git/") && !line.startsWith("node_modules/"))
          .slice(0, options.limit);
        return lines.map((line) => resolve(searchCwd, line));
      },
    };
  }

  createLsOperations(): LsOperations {
    return {
      exists: async (absolutePath) => {
        await this.pathRestriction.assertAllowedAbsolutePath(absolutePath);
        const result = await this.execDockerCommand('[ -e "$ADJ_PATH" ]', {
          env: { ADJ_PATH: this.toContainerPath(absolutePath) },
        });
        return parseBooleanExit(result);
      },
      stat: async (absolutePath) => {
        await this.pathRestriction.assertAllowedAbsolutePath(absolutePath);
        const existsResult = await this.execDockerCommand('[ -e "$ADJ_PATH" ]', {
          env: { ADJ_PATH: this.toContainerPath(absolutePath) },
        });
        if (!parseBooleanExit(existsResult)) {
          throw new Error(`Path not found: ${absolutePath}`);
        }
        const dirResult = await this.execDockerCommand('[ -d "$ADJ_PATH" ]', {
          env: { ADJ_PATH: this.toContainerPath(absolutePath) },
        });
        return {
          isDirectory: () => parseBooleanExit(dirResult),
        };
      },
      readdir: async (absolutePath) => {
        await this.pathRestriction.assertAllowedAbsolutePath(absolutePath);
        const result = await this.execDockerCommand('ls -1A -- "$ADJ_PATH"', {
          env: { ADJ_PATH: this.toContainerPath(absolutePath) },
        });
        if (result.exitCode !== 0) {
          const stderr = result.stderr.toString("utf-8").trim();
          throw new Error(stderr || `Cannot read directory: ${absolutePath}`);
        }
        const text = result.stdout.toString("utf-8").trim();
        if (!text) {
          return [];
        }
        return text.split("\n").map((line) => line.trim());
      },
    };
  }

  createToolDefinitions(): ToolDefinition[] {
    const read = createReadTool(this.runSpec.hostWorkspaceDir, {
      operations: this.createReadOperations(),
    });
    const write = createWriteTool(this.runSpec.hostWorkspaceDir, {
      operations: this.createWriteOperations(),
    });
    const edit = createEditTool(this.runSpec.hostWorkspaceDir, {
      operations: this.createEditOperations(),
    });
    const find = createFindTool(this.runSpec.hostWorkspaceDir, {
      operations: this.createFindOperations(),
    });
    const ls = createLsTool(this.runSpec.hostWorkspaceDir, {
      operations: this.createLsOperations(),
    });
    const grep = this.createGrepTool();
    return [
      read as unknown as ToolDefinition,
      write as unknown as ToolDefinition,
      edit as unknown as ToolDefinition,
      grep,
      find as unknown as ToolDefinition,
      ls as unknown as ToolDefinition,
    ];
  }

  private createGrepTool(): ToolDefinition {
    const baseGrepTool = createGrepTool(this.runSpec.hostWorkspaceDir);
    return {
      ...baseGrepTool,
      execute: async (_toolCallId, input, signal) => {
        const params = input as GrepToolInput;
        const rawSearchPath = typeof params.path === "string" ? params.path : ".";
        await this.pathRestriction.assertAllowedInputPath(rawSearchPath);
        const hostSearchPath = resolve(this.runSpec.hostWorkspaceDir, rawSearchPath);
        const searchPath = this.toContainerPath(hostSearchPath);

        const existsResult = await this.execDockerCommand('[ -e "$ADJ_PATH" ]', {
          env: { ADJ_PATH: searchPath },
          signal,
        });
        if (!parseBooleanExit(existsResult)) {
          throw new Error(`Path not found: ${hostSearchPath}`);
        }

        const isDirectoryResult = await this.execDockerCommand('[ -d "$ADJ_PATH" ]', {
          env: { ADJ_PATH: searchPath },
          signal,
        });
        const isDirectory = parseBooleanExit(isDirectoryResult);

        const args = ["rg", "--json", "--line-number", "--color=never", "--hidden"];
        if (params.ignoreCase) {
          args.push("--ignore-case");
        }
        if (params.literal) {
          args.push("--fixed-strings");
        }
        if (params.glob) {
          args.push("--glob", params.glob);
        }
        args.push(params.pattern, searchPath);

        const rgResult = await this.execDockerCommand(args.map(shellQuote).join(" "), { signal });
        const rgStderr = rgResult.stderr.toString("utf-8").trim();
        if (rgResult.exitCode !== 0 && rgResult.exitCode !== 1) {
          throw new Error(rgStderr || `ripgrep exited with code ${String(rgResult.exitCode)}`);
        }

        const effectiveLimit = Math.max(1, params.limit ?? GREP_DEFAULT_LIMIT);
        const contextValue = params.context && params.context > 0 ? params.context : 0;
        const matches: GrepMatch[] = [];

        const lines = rgResult.stdout
          .toString("utf-8")
          .split("\n")
          .filter((line) => line.trim().length > 0);
        for (const line of lines) {
          let event: unknown;
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }
          const data = event as {
            type?: string;
            data?: {
              path?: { text?: string };
              line_number?: number;
            };
          };
          if (data.type !== "match") {
            continue;
          }
          const filePath = data.data?.path?.text;
          const lineNumber = data.data?.line_number;
          if (!filePath || typeof lineNumber !== "number") {
            continue;
          }
          matches.push({ filePath, lineNumber });
        }

        if (matches.length === 0) {
          return { content: [{ type: "text", text: "No matches found" }], details: undefined };
        }

        const matchLimitReached = matches.length > effectiveLimit;
        const selectedMatches = matches.slice(0, effectiveLimit);
        const outputLines: string[] = [];
        const fileCache = new Map<string, string[]>();
        let linesTruncated = false;

        for (const match of selectedMatches) {
          const formattedPath = this.formatGrepPath({
            filePath: match.filePath,
            searchPath,
            isDirectory,
          });
          if (contextValue <= 0) {
            const lineText = await this.readLine(match.filePath, match.lineNumber, fileCache);
            const truncated = truncateLine(lineText.replace(/\r/g, ""), GREP_MAX_LINE_LENGTH);
            if (truncated.wasTruncated) {
              linesTruncated = true;
            }
            outputLines.push(`${formattedPath}:${match.lineNumber}: ${truncated.text}`);
            continue;
          }

          const sourceLines = await this.readAllLines(match.filePath, fileCache);
          if (sourceLines.length === 0) {
            outputLines.push(`${formattedPath}:${match.lineNumber}: (unable to read file)`);
            continue;
          }
          const start = Math.max(1, match.lineNumber - contextValue);
          const end = Math.min(sourceLines.length, match.lineNumber + contextValue);
          for (let current = start; current <= end; current += 1) {
            const rawLine = sourceLines[current - 1] ?? "";
            const truncated = truncateLine(rawLine.replace(/\r/g, ""), GREP_MAX_LINE_LENGTH);
            if (truncated.wasTruncated) {
              linesTruncated = true;
            }
            if (current === match.lineNumber) {
              outputLines.push(`${formattedPath}:${current}: ${truncated.text}`);
            } else {
              outputLines.push(`${formattedPath}-${current}- ${truncated.text}`);
            }
          }
        }

        const rawOutput = outputLines.join("\n");
        const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
        const details: {
          truncation?: ReturnType<typeof truncateHead>;
          matchLimitReached?: number;
          linesTruncated?: boolean;
        } = {};
        const notices: string[] = [];
        if (matchLimitReached) {
          details.matchLimitReached = effectiveLimit;
          notices.push(
            `${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`
          );
        }
        if (truncation.truncated) {
          details.truncation = truncation;
          notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
        }
        if (linesTruncated) {
          details.linesTruncated = true;
          notices.push(
            `Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`
          );
        }

        let output = truncation.content;
        if (notices.length > 0) {
          output += `\n\n[${notices.join(". ")}]`;
        }
        return {
          content: [{ type: "text", text: output }],
          details: Object.keys(details).length > 0 ? details : undefined,
        };
      },
    } as ToolDefinition;
  }

  private async readLine(
    filePath: string,
    lineNumber: number,
    cache: Map<string, string[]>
  ): Promise<string> {
    const lines = await this.readAllLines(filePath, cache);
    return lines[lineNumber - 1] ?? "";
  }

  private async readAllLines(filePath: string, cache: Map<string, string[]>): Promise<string[]> {
    const cached = cache.get(filePath);
    if (cached) {
      return cached;
    }
    const result = await this.execDockerCommand('cat -- "$ADJ_PATH"', {
      env: { ADJ_PATH: filePath },
    });
    if (result.exitCode !== 0) {
      cache.set(filePath, []);
      return [];
    }
    const lines = result.stdout
      .toString("utf-8")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .split("\n");
    cache.set(filePath, lines);
    return lines;
  }

  private formatGrepPath(params: {
    filePath: string;
    searchPath: string;
    isDirectory: boolean;
  }): string {
    if (!params.isDirectory) {
      return basename(params.filePath);
    }
    const relative = pathPosix.relative(params.searchPath, params.filePath);
    if (relative && !relative.startsWith("..")) {
      return relative;
    }
    return basename(params.filePath);
  }

  private toContainerPath(hostPath: string): string {
    return this.pathMapper.hostToContainer(hostPath);
  }

  private async execDockerCommand(
    command: string,
    options: ExecDockerCommandOptions = {}
  ): Promise<DockerRunResult> {
    if (options.signal?.aborted) {
      throw new Error("Operation aborted");
    }

    const cwd = options.cwd ?? this.runSpec.hostWorkspaceDir;
    const containerCwd = this.pathMapper.hostToContainer(cwd);
    const args = buildDockerRunArgs({
      runSpec: this.runSpec,
      containerCwd,
      command,
      env: options.env,
    });

    return await new Promise<DockerRunResult>((resolveResult, rejectResult) => {
      const child = this.spawnImpl(this.dockerBin, args, {
        stdio: ["pipe", "pipe", "pipe"],
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let aborted = false;
      const onAbort = () => {
        aborted = true;
        child.kill("SIGKILL");
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutChunks.push(Buffer.from(chunk));
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrChunks.push(Buffer.from(chunk));
      });

      child.on("error", (error) => {
        options.signal?.removeEventListener("abort", onAbort);
        rejectResult(error);
      });

      child.on("close", (code) => {
        options.signal?.removeEventListener("abort", onAbort);
        if (aborted) {
          rejectResult(new Error("Operation aborted"));
          return;
        }
        resolveResult({
          exitCode: code,
          stdout: Buffer.concat(stdoutChunks),
          stderr: Buffer.concat(stderrChunks),
        });
      });

      if (options.stdin !== undefined) {
        child.stdin.write(options.stdin);
      }
      child.stdin.end();
    });
  }

  private assertCommandSucceeded(result: DockerRunResult): void {
    if (result.exitCode === 0) {
      return;
    }
    const stderr = result.stderr.toString("utf-8").trim();
    throw new Error(stderr || `Command exited with code ${String(result.exitCode)}`);
  }
}

export function createContainerizedFileTools(
  options: ContainerizedFileToolOptions
): ToolDefinition[] {
  return new ContainerizedFileToolOperations(options).createToolDefinitions();
}

export { getWorkspacePathNotAllowedMessage };
