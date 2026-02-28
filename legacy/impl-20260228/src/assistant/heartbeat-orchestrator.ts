import type { HeartbeatRunResult } from "./types.js";

type IntervalTimer = ReturnType<typeof setInterval>;
type TimeoutTimer = ReturnType<typeof setTimeout>;

type HeartbeatOrchestratorDeps = {
  intervalMs: number;
  retryDelayMs: number;
  runTick: (reason: string) => Promise<HeartbeatRunResult>;
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
};

export class HeartbeatOrchestrator {
  private stopped = false;
  private running = false;
  private intervalTimer: IntervalTimer | null = null;
  private retryTimer: TimeoutTimer | null = null;

  constructor(private readonly deps: HeartbeatOrchestratorDeps) {}

  start(): void {
    if (this.intervalTimer) {
      return;
    }
    this.intervalTimer = this.deps.setInterval(() => {
      void this.executeTick("timer");
    }, this.deps.intervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.intervalTimer) {
      this.deps.clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
    if (this.retryTimer) {
      this.deps.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) {
      return;
    }
    this.retryTimer = this.deps.setTimeout(() => {
      this.retryTimer = null;
      void this.executeTick("requests-in-flight-retry");
    }, this.deps.retryDelayMs);
  }

  private async executeTick(reason: string): Promise<void> {
    if (this.stopped || this.running) {
      return;
    }
    this.running = true;
    try {
      const result = await this.deps.runTick(reason);
      if (result.status === "skipped" && result.reason === "requests-in-flight") {
        this.scheduleRetry();
      }
    } finally {
      this.running = false;
    }
  }
}
