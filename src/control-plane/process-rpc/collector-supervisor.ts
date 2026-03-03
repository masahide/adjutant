import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type { JsonRpcFailure } from "../../contracts/process-rpc/rpc-types.js";
import {
  attachUtf8LineReader,
  computeNextRestartCount,
  isUnexpectedChildExit,
  sleep,
} from "../supervisor/stdio-supervisor-utils.js";
import { ProcessRpcServer, parseJsonRpcRequestLine } from "./server.js";

export type CollectorSupervisorLogEntry = {
  level?: "info" | "warn" | "error";
  code: string;
  message: string;
  [key: string]: unknown;
};

export type CollectorSupervisorOptions = {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  processRpcServer: ProcessRpcServer;
  maxRestarts?: number;
  restartDelayMs?: number;
  startupDelayMs?: number;
  stopTimeoutMs?: number;
  requestTimeoutMs?: number;
  onLog?: (entry: CollectorSupervisorLogEntry) => void;
};

function createJsonRpcFailure(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown
): JsonRpcFailure {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      data,
    },
  };
}

function withTimeout<T>(task: Promise<T>, timeoutMs: number, onTimeout: () => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new Error("PROCESS_RPC_TIMEOUT"));
    }, timeoutMs);

    task.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export class CollectorSupervisor {
  private child?: ChildProcessWithoutNullStreams;
  private restartCount = 0;
  private stopping = false;

  constructor(private readonly options: CollectorSupervisorOptions) {}

  async start(): Promise<void> {
    this.stopping = false;
    if (this.child === undefined) {
      this.spawnChild();
    }
    await this.waitForSpawnReady();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    this.child = undefined;
    if (child === undefined) {
      return;
    }

    await new Promise<void>((resolve) => {
      let exited = false;
      const timeoutMs = this.options.stopTimeoutMs ?? 2_000;
      const timer = setTimeout(() => {
        if (!exited) {
          child.kill("SIGKILL");
        }
      }, timeoutMs);

      child.once("exit", () => {
        exited = true;
        clearTimeout(timer);
        resolve();
      });

      child.kill("SIGTERM");
    });
  }

  killChildForTest(signal: NodeJS.Signals = "SIGKILL"): void {
    this.child?.kill(signal);
  }

  getRestartCount(): number {
    return this.restartCount;
  }

  private spawnChild(): void {
    const child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: this.options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    attachUtf8LineReader(child.stdout, (line) => {
      void this.handleRequestLine(child, line);
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      const line = chunk.trim();
      if (line.length === 0) {
        return;
      }
      this.options.onLog?.({
        level: "warn",
        code: "COLLECTOR_STDERR",
        message: "collector stderr output",
        stderr: line,
      });
    });

    child.on("error", (error) => {
      if (this.stopping) {
        return;
      }
      this.options.onLog?.({
        level: "error",
        code: "COLLECTOR_PROCESS_ERROR",
        message: "collector process error",
        reason: error.message,
      });
    });

    child.stdin.on("error", (error) => {
      if (this.stopping) {
        return;
      }
      this.options.onLog?.({
        level: "error",
        code: "COLLECTOR_STDIN_ERROR",
        message: "collector stdin error",
        reason: error.message,
      });
    });

    child.on("exit", (code, signal) => {
      const crashed = isUnexpectedChildExit(this.stopping, code, signal);
      if (this.child === child) {
        this.child = undefined;
      }

      if (crashed) {
        this.options.onLog?.({
          level: "error",
          code: "COLLECTOR_CRASHED",
          message: "collector process exited unexpectedly",
          exitCode: code,
          signal,
          restartCount: this.restartCount,
        });
      }

      const nextRestartCount = computeNextRestartCount({
        crashed,
        restartCount: this.restartCount,
        maxRestarts: this.options.maxRestarts ?? 1,
      });
      if (nextRestartCount !== null) {
        this.restartCount = nextRestartCount;
        const restartDelayMs = this.options.restartDelayMs ?? 50;
        setTimeout(() => {
          if (!this.stopping) {
            this.spawnChild();
          }
        }, restartDelayMs);
      }
    });

    this.child = child;
  }

  private async waitForSpawnReady(): Promise<void> {
    const delayMs = this.options.startupDelayMs ?? 30;
    await sleep(delayMs);

    if (this.child === undefined || this.child.killed) {
      throw new Error("COLLECTOR_NOT_RUNNING");
    }
  }

  private async handleRequestLine(
    child: ChildProcessWithoutNullStreams,
    line: string
  ): Promise<void> {
    const parsed = parseJsonRpcRequestLine(line);
    if ("error" in parsed) {
      this.writeLine(child, parsed);
      return;
    }

    const requestTimeoutMs = this.options.requestTimeoutMs ?? 3_000;
    let response;
    try {
      response = await withTimeout(
        this.options.processRpcServer.handleRequest(parsed),
        requestTimeoutMs,
        () => {
          this.options.onLog?.({
            level: "warn",
            code: "COLLECTOR_RPC_TIMEOUT",
            message: "collector request timed out",
            method: parsed.method,
            id: parsed.id,
            timeoutMs: requestTimeoutMs,
          });
        }
      );
    } catch (error) {
      response = createJsonRpcFailure(parsed.id, -32000, "DOWNSTREAM_ERROR", {
        message: error instanceof Error ? error.message : String(error),
      });
    }

    this.writeLine(child, response);
  }

  private writeLine(child: ChildProcessWithoutNullStreams, payload: unknown): void {
    if (this.child !== child || child.killed) {
      return;
    }
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  }
}
