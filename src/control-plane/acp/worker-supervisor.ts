import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

export interface WorkerSupervisorOptions {
  command: string;
  args: string[];
  cwd: string;
  maxRestarts?: number;
  restartDelayMs?: number;
  onLog?: (entry: Record<string, unknown>) => void;
}

export interface WorkerRequestOptions {
  timeoutMs?: number;
}

export class WorkerSupervisor {
  private child?: ChildProcessWithoutNullStreams;
  private buffer = "";
  private nextId = 1;
  private restartCount = 0;
  private stopping = false;
  private readonly pending = new Map<
    number,
    {
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

    this.child.kill("SIGTERM");
    this.child.removeAllListeners();
    this.child = undefined;
  }

  async request(
    method: string,
    params: Record<string, unknown>,
    options: WorkerRequestOptions = {}
  ): Promise<Record<string, unknown>> {
    if (this.child === undefined || this.child.killed) {
      throw new Error("WORKER_NOT_RUNNING");
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

      this.pending.set(id, { resolve, reject, timer });
      this.child?.stdin.write(`${JSON.stringify(envelope)}\n`);
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
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      let newlineIndex = this.buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = this.buffer.slice(0, newlineIndex).trim();
        this.buffer = this.buffer.slice(newlineIndex + 1);
        if (line.length > 0) {
          this.handleEnvelope(line);
        }
        newlineIndex = this.buffer.indexOf("\n");
      }
    });

    child.on("exit", (code, signal) => {
      const crashed = !this.stopping && (code !== 0 || signal !== null);
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

      if (crashed && this.restartCount < (this.options.maxRestarts ?? 1)) {
        this.restartCount += 1;
        setTimeout(() => this.spawnChild(), this.options.restartDelayMs ?? 25);
      }
    });

    this.child = child;
  }

  private waitForSpawnReady(): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, 30);
    });
  }

  private handleEnvelope(line: string): void {
    let parsed: JsonRpcResponse;
    try {
      parsed = JSON.parse(line) as JsonRpcResponse;
    } catch {
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

    pending.resolve(parsed.result ?? {});
  }
}
