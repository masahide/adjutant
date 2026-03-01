import type { ChatStreamEvent } from "../contracts/http-api.js";
import type { RunFailureSummary } from "./run-lifecycle.js";

interface RunEventState {
  sessionKey: string;
  events: ChatStreamEvent[];
  subscribers: Set<(event: ChatStreamEvent) => void>;
  disposeTimer?: NodeJS.Timeout;
}

export type { ChatStreamEvent, RunFailureSummary };

export interface RunEventBufferOptions {
  retentionMs?: number;
  setTimeoutFn?: (callback: () => void, timeoutMs: number) => NodeJS.Timeout;
  clearTimeoutFn?: (timer: NodeJS.Timeout) => void;
}

export class RunEventBuffer {
  private readonly retentionMs: number;
  private readonly setTimeoutFn: (callback: () => void, timeoutMs: number) => NodeJS.Timeout;
  private readonly clearTimeoutFn: (timer: NodeJS.Timeout) => void;
  private readonly byRunId = new Map<string, RunEventState>();

  constructor(options: RunEventBufferOptions = {}) {
    this.retentionMs = options.retentionMs ?? 60_000;
    this.setTimeoutFn =
      options.setTimeoutFn ?? ((callback, timeoutMs) => setTimeout(callback, timeoutMs));
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((timer) => clearTimeout(timer));
  }

  ensureRun(runId: string, sessionKey: string): void {
    const existing = this.byRunId.get(runId);
    if (existing !== undefined) {
      existing.sessionKey = sessionKey;
      return;
    }
    this.byRunId.set(runId, {
      sessionKey,
      events: [],
      subscribers: new Set(),
    });
  }

  hasRun(runId: string): boolean {
    return this.byRunId.has(runId);
  }

  sessionKey(runId: string): string | undefined {
    return this.byRunId.get(runId)?.sessionKey;
  }

  append(runId: string, event: Omit<ChatStreamEvent, "seq">): ChatStreamEvent {
    this.ensureRun(runId, event.sessionKey);
    const entry = this.byRunId.get(runId);
    if (entry === undefined) {
      throw new Error(`run not found after ensure: ${runId}`);
    }
    if (entry.disposeTimer !== undefined) {
      this.clearTimeoutFn(entry.disposeTimer);
      entry.disposeTimer = undefined;
    }

    const fullEvent: ChatStreamEvent = {
      ...event,
      seq: entry.events.length + 1,
    };
    entry.events.push(fullEvent);
    for (const subscriber of entry.subscribers) {
      subscriber(fullEvent);
    }
    if (
      fullEvent.state === "final" ||
      fullEvent.state === "error" ||
      fullEvent.state === "aborted"
    ) {
      entry.disposeTimer = this.setTimeoutFn(() => this.dispose(runId), this.retentionMs);
    }
    return fullEvent;
  }

  replay(runId: string, fromSeq: number): ChatStreamEvent[] {
    const entry = this.byRunId.get(runId);
    if (entry === undefined) {
      return [];
    }
    return entry.events.filter((event) => event.seq >= fromSeq);
  }

  subscribe(runId: string, listener: (event: ChatStreamEvent) => void): () => void {
    const entry = this.byRunId.get(runId);
    if (entry === undefined) {
      return () => {};
    }
    entry.subscribers.add(listener);
    return () => {
      entry.subscribers.delete(listener);
    };
  }

  dispose(runId: string): void {
    const entry = this.byRunId.get(runId);
    if (entry === undefined) {
      return;
    }
    if (entry.disposeTimer !== undefined) {
      this.clearTimeoutFn(entry.disposeTimer);
    }
    entry.subscribers.clear();
    this.byRunId.delete(runId);
  }
}
