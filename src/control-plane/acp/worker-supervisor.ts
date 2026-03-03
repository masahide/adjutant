import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  attachUtf8LineReader,
  computeNextRestartCount,
  isUnexpectedChildExit,
  sleep,
} from "../supervisor/stdio-supervisor-utils.js";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

export interface WorkerSupervisorOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  maxRestarts?: number;
  restartDelayMs?: number;
  healthcheckTimeoutMs?: number;
  onLog?: (entry: Record<string, unknown>) => void;
  onNotification?: (notification: { method: string; params: Record<string, unknown> }) => void;
}

export interface WorkerRequestOptions {
  timeoutMs?: number;
}

export class WorkerSupervisor {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private restartCount = 0;
  private stopping = false;
  private ready = false;
  private readonly pending = new Map<
    number,
    {
      method: string;
      resolve: (value: Record<string, unknown>) => void;
      reject: (reason: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();

  constructor(private readonly options: WorkerSupervisorOptions) {}

  async start(): Promise<void> {
    this.stopping = false;
    this.spawnChild();
    await this.waitForSpawnReady();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.child === undefined) {
      return;
    }

    this.failAllPending(new Error("WORKER_STOPPED"));
    this.child.kill("SIGTERM");
    this.child.removeAllListeners();
    this.child = undefined;
    this.ready = false;
  }

  async request(
    method: string,
    params: Record<string, unknown>,
    options: WorkerRequestOptions = {}
  ): Promise<Record<string, unknown>> {
    if (this.child === undefined || this.child.killed) {
      throw new Error("WORKER_NOT_RUNNING");
    }
    if (!this.ready && method !== "initialize") {
      throw new Error(`WORKER_NOT_READY: ${method}`);
    }

    const id = this.nextId++;
    const timeoutMs = options.timeoutMs ?? 1000;

    const envelope: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`WORKER_TIMEOUT: ${method}`));
      }, timeoutMs);

      this.pending.set(id, { method, resolve, reject, timer });
      this.child?.stdin.write(`${JSON.stringify(envelope)}\n`, (error) => {
        if (error == null) {
          return;
        }
        const pending = this.pending.get(id);
        if (pending === undefined) {
          return;
        }
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(new Error(`WORKER_IO_ERROR: ${method}: ${error.message}`));
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
    this.ready = false;

    attachUtf8LineReader(child.stdout, (line) => {
      this.handleEnvelope(line);
    });
    child.stdin.on("error", (error) => {
      if (this.stopping) {
        return;
      }
      this.options.onLog?.({
        level: "error",
        code: "WORKER_STDIN_ERROR",
        message: "worker stdin error",
        reason: error.message,
      });
      this.failAllPending(new Error(`WORKER_IO_ERROR: ${error.message}`));
    });
    child.on("error", (error) => {
      if (this.stopping) {
        return;
      }
      this.options.onLog?.({
        level: "error",
        code: "WORKER_PROCESS_ERROR",
        message: "worker process error",
        reason: error.message,
      });
      this.failAllPending(new Error(`WORKER_CRASHED: ${error.message}`));
    });

    child.on("exit", (code, signal) => {
      const crashed = isUnexpectedChildExit(this.stopping, code, signal);
      this.failAllPending(
        new Error(`WORKER_CRASHED: exit=${String(code)} signal=${String(signal)}`)
      );
      if (this.child === child) {
        this.child = undefined;
      }
      this.ready = false;
      if (crashed) {
        this.options.onLog?.({
          level: "error",
          code: "WORKER_CRASHED",
          message: "worker process exited unexpectedly",
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
        setTimeout(() => this.spawnChild(), this.options.restartDelayMs ?? 25);
      }
    });

    this.child = child;
    void this.runHealthcheck(child);
  }

  private async waitForSpawnReady(): Promise<void> {
    await sleep(30);
  }

  private handleEnvelope(line: string): void {
    let parsed: JsonRpcResponse;
    try {
      parsed = JSON.parse(line) as JsonRpcResponse;
    } catch {
      return;
    }

    if (parsed.id === undefined) {
      if (typeof parsed.method === "string") {
        this.options.onNotification?.({
          method: parsed.method,
          params: parsed.params ?? {},
        });
      }
      return;
    }

    if (typeof parsed.id !== "number") {
      return;
    }

    const pending = this.pending.get(parsed.id);
    if (pending === undefined) {
      return;
    }

    clearTimeout(pending.timer);
    this.pending.delete(parsed.id);

    if (parsed.error !== undefined) {
      pending.reject(new Error(parsed.error.message));
      return;
    }

    if (pending.method === "initialize") {
      this.ready = true;
    }
    pending.resolve(parsed.result ?? {});
  }

  private failAllPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(error);
    }
  }

  private async runHealthcheck(child: ChildProcessWithoutNullStreams): Promise<void> {
    try {
      await this.request(
        "initialize",
        { protocolVersion: 1 },
        { timeoutMs: this.options.healthcheckTimeoutMs ?? 2000 }
      );
      if (this.child === child) {
        this.ready = true;
      }
    } catch (error) {
      if (this.stopping || this.child !== child) {
        return;
      }
      this.options.onLog?.({
        level: "warn",
        code: "WORKER_HEALTHCHECK_FAILED",
        message: "worker healthcheck failed",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
