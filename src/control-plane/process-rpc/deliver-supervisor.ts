import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type {
  DeliverCompletedNotification,
  DeliverEnqueueRequest,
  DeliverEnqueueResponse,
} from "../../contracts/process-rpc/method-types.js";
import { validateDeliverCompletedNotification } from "../../contracts/process-rpc/rpc-types.js";
import {
  attachUtf8LineReader,
  computeNextRestartCount,
  isUnexpectedChildExit,
  sleep,
} from "../supervisor/stdio-supervisor-utils.js";

interface JsonRpcSuccess<TResult = unknown> {
  jsonrpc: "2.0";
  id: string | number;
  result: TResult;
}

interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: string | number | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

type JsonRpcEnvelope = JsonRpcSuccess | JsonRpcFailure | JsonRpcNotification;

export type DeliverSupervisorLogEntry = {
  level?: "info" | "warn" | "error";
  code: string;
  message: string;
  [key: string]: unknown;
};

export type DeliverSupervisorOptions = {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  maxRestarts?: number;
  restartDelayMs?: number;
  startupDelayMs?: number;
  stopTimeoutMs?: number;
  requestTimeoutMs?: number;
  onLog?: (entry: DeliverSupervisorLogEntry) => void;
  onCompleted?: (notification: DeliverCompletedNotification) => void;
};

export type DeliverSupervisorRequestOptions = {
  timeoutMs?: number;
};

type PendingRequest = {
  resolve: (value: DeliverEnqueueResponse) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonRpcEnvelope(line: string): JsonRpcEnvelope | undefined {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!isObject(parsed) || parsed.jsonrpc !== "2.0") {
      return undefined;
    }
    return parsed as unknown as JsonRpcEnvelope;
  } catch {
    return undefined;
  }
}

function isDeliverEnqueueResponse(value: unknown): value is DeliverEnqueueResponse {
  if (!isObject(value)) {
    return false;
  }
  return (
    typeof value.messageId === "string" &&
    value.status === "accepted" &&
    typeof value.acceptedAt === "string"
  );
}

export class DeliverSupervisor {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private restartCount = 0;
  private stopping = false;
  private readonly pending = new Map<number, PendingRequest>();

  constructor(private readonly options: DeliverSupervisorOptions) {}

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
    this.failAllPending(new Error("DELIVER_STOPPED"));
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

  async enqueue(
    request: DeliverEnqueueRequest,
    options: DeliverSupervisorRequestOptions = {}
  ): Promise<DeliverEnqueueResponse> {
    const child = this.child;
    if (child === undefined || child.killed) {
      throw new Error("DELIVER_NOT_RUNNING");
    }

    const id = this.nextId++;
    const timeoutMs = options.timeoutMs ?? this.options.requestTimeoutMs ?? 3_000;
    const envelope = {
      jsonrpc: "2.0" as const,
      id,
      method: "deliver/enqueue",
      params: request,
    };

    return await new Promise<DeliverEnqueueResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.options.onLog?.({
          level: "warn",
          code: "DELIVER_RPC_TIMEOUT",
          message: "deliver request timed out",
          method: "deliver/enqueue",
          id,
          timeoutMs,
        });
        reject(new Error("DELIVER_TIMEOUT"));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify(envelope)}\n`, (error) => {
        if (error == null) {
          return;
        }
        const pending = this.pending.get(id);
        if (pending === undefined) {
          return;
        }
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(new Error(`DELIVER_IO_ERROR: ${error.message}`));
      });
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
      this.handleEnvelope(line);
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      const line = chunk.trim();
      if (line.length === 0) {
        return;
      }
      this.options.onLog?.({
        level: "warn",
        code: "DELIVER_STDERR",
        message: "deliver stderr output",
        stderr: line,
      });
    });

    child.stdin.on("error", (error) => {
      if (this.stopping) {
        return;
      }
      this.options.onLog?.({
        level: "error",
        code: "DELIVER_STDIN_ERROR",
        message: "deliver stdin error",
        reason: error.message,
      });
      this.failAllPending(new Error(`DELIVER_IO_ERROR: ${error.message}`));
    });

    child.on("error", (error) => {
      if (this.stopping) {
        return;
      }
      this.options.onLog?.({
        level: "error",
        code: "DELIVER_PROCESS_ERROR",
        message: "deliver process error",
        reason: error.message,
      });
      this.failAllPending(new Error(`DELIVER_CRASHED: ${error.message}`));
    });

    child.on("exit", (code, signal) => {
      const crashed = isUnexpectedChildExit(this.stopping, code, signal);
      if (this.child === child) {
        this.child = undefined;
      }
      this.failAllPending(
        new Error(`DELIVER_CRASHED: exit=${String(code)} signal=${String(signal)}`)
      );
      if (crashed) {
        this.options.onLog?.({
          level: "error",
          code: "DELIVER_CRASHED",
          message: "deliver process exited unexpectedly",
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
      throw new Error("DELIVER_NOT_RUNNING");
    }
  }

  private handleEnvelope(line: string): void {
    const parsed = parseJsonRpcEnvelope(line);
    if (parsed === undefined) {
      return;
    }

    if ("id" in parsed && parsed.id !== undefined) {
      if (typeof parsed.id !== "number") {
        return;
      }
      const pending = this.pending.get(parsed.id);
      if (pending === undefined) {
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(parsed.id);

      if ("error" in parsed && parsed.error !== undefined) {
        pending.reject(new Error(parsed.error.message));
        return;
      }
      const result = "result" in parsed ? parsed.result : undefined;
      if (!isDeliverEnqueueResponse(result)) {
        pending.reject(new Error("DELIVER_PROTOCOL_ERROR"));
        return;
      }
      pending.resolve(result);
      return;
    }

    if ("method" in parsed && parsed.method === "deliver/completed") {
      if (!validateDeliverCompletedNotification(parsed.params)) {
        this.options.onLog?.({
          level: "warn",
          code: "DELIVER_COMPLETED_INVALID",
          message: "invalid deliver/completed notification",
        });
        return;
      }
      this.options.onCompleted?.(parsed.params);
    }
  }

  private failAllPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(error);
    }
  }
}
