import { loadCollectorSlackConfig, type CollectorCdpEndpoint } from "./config.js";
import { toErrorMessage } from "./errors.js";
import { noopCollectorLogger, type CollectorLogEntry, type CollectorLogger } from "./logger.js";

export type CollectorConnection = {
  waitClosed: () => Promise<void>;
  close: () => Promise<void>;
};

export type CollectorMainDeps = {
  connect: (endpoint: CollectorCdpEndpoint) => Promise<CollectorConnection>;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  onLog?: CollectorLogger;
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function computeFullJitterDelayMs(
  attempt: number,
  random: () => number = Math.random
): number {
  const normalizedAttempt = Math.max(1, Math.floor(attempt));
  const maxDelay = Math.min(10_000, 1_000 * 2 ** (normalizedAttempt - 1));
  return Math.floor(random() * maxDelay);
}

export class CollectorSlackMain {
  private running = false;
  private stopping = false;
  private loopTask: Promise<void> | null = null;
  private activeConnection: CollectorConnection | null = null;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly onLog: CollectorLogger;

  constructor(private readonly deps: CollectorMainDeps) {
    this.sleep = deps.sleep ?? defaultSleep;
    this.random = deps.random ?? Math.random;
    this.onLog = deps.onLog ?? noopCollectorLogger;
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    this.stopping = false;
    this.loopTask = this.runLoop();
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }
    this.stopping = true;
    if (this.activeConnection !== null) {
      await this.activeConnection.close();
    }
    await this.loopTask;
    this.loopTask = null;
    this.running = false;
  }

  private async runLoop(): Promise<void> {
    let attempt = 1;
    while (!this.stopping) {
      const endpoint = loadCollectorSlackConfig().endpoint;
      try {
        this.log({
          level: "info",
          event: "collector.connect.start",
          endpointHost: endpoint.host,
          endpointPort: endpoint.port,
          endpointSource: endpoint.source,
        });
        const connection = await this.deps.connect(endpoint);
        this.activeConnection = connection;
        attempt = 1;
        await connection.waitClosed();
        this.activeConnection = null;
        if (this.stopping) {
          break;
        }
        this.log({
          level: "warn",
          event: "collector.connect.closed",
        });
      } catch (error) {
        this.activeConnection = null;
        if (this.stopping) {
          break;
        }
        this.log({
          level: "warn",
          event: "collector.connect.failed",
          message: toErrorMessage(error),
          attempt,
        });
      }

      if (this.stopping) {
        break;
      }
      const delayMs = computeFullJitterDelayMs(attempt, this.random);
      this.log({
        level: "info",
        event: "collector.reconnect.wait",
        attempt,
        delayMs,
      });
      attempt += 1;
      await this.sleep(delayMs);
    }
  }

  private log(entry: CollectorLogEntry): void {
    this.onLog(entry);
  }
}
