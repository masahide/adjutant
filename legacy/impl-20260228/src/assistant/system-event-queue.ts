import type { SystemEvent } from "./types.js";

export type SystemEventEnqueueOptions = {
  sessionKey: string;
  contextKey?: string;
};

const MAX_EVENTS = 20;

type SessionQueue = {
  queue: SystemEvent[];
  lastText: string | null;
  lastContextKey: string | null;
};

const queues = new Map<string, SessionQueue>();

function requireSessionKey(value: string): string {
  const cleaned = value.trim();
  if (!cleaned) {
    throw new Error("system events require a sessionKey");
  }
  return cleaned;
}

function normalizeContextKey(value?: string): string | null {
  if (!value) {
    return null;
  }
  const cleaned = value.trim();
  if (!cleaned) {
    return null;
  }
  return cleaned.toLowerCase();
}

function getOrCreateQueue(sessionKey: string): SessionQueue {
  const existing = queues.get(sessionKey);
  if (existing) {
    return existing;
  }
  const created: SessionQueue = {
    queue: [],
    lastText: null,
    lastContextKey: null,
  };
  queues.set(sessionKey, created);
  return created;
}

export function isSystemEventContextChanged(sessionKey: string, contextKey?: string): boolean {
  const key = requireSessionKey(sessionKey);
  const normalized = normalizeContextKey(contextKey);
  const existing = queues.get(key);
  return normalized !== (existing?.lastContextKey ?? null);
}

export function enqueueSystemEvent(text: string, opts: SystemEventEnqueueOptions): void {
  const sessionKey = requireSessionKey(opts.sessionKey);
  const eventText = text.trim();
  if (!eventText) {
    return;
  }

  const target = getOrCreateQueue(sessionKey);
  target.lastContextKey = normalizeContextKey(opts.contextKey);

  if (target.lastText === eventText) {
    return;
  }
  target.lastText = eventText;

  target.queue.push({ text: eventText, ts: Date.now() });
  if (target.queue.length > MAX_EVENTS) {
    target.queue.shift();
  }
}

export function drainSystemEventEntries(sessionKey: string): SystemEvent[] {
  const key = requireSessionKey(sessionKey);
  const target = queues.get(key);
  if (!target || target.queue.length === 0) {
    return [];
  }

  const drained = target.queue.slice();
  target.queue.length = 0;
  target.lastText = null;
  target.lastContextKey = null;
  queues.delete(key);
  return drained;
}

export function drainSystemEvents(sessionKey: string): string[] {
  return drainSystemEventEntries(sessionKey).map((event) => event.text);
}

export function peekSystemEvents(sessionKey: string): string[] {
  const key = requireSessionKey(sessionKey);
  return queues.get(key)?.queue.map((event) => event.text) ?? [];
}

export function hasSystemEvents(sessionKey: string): boolean {
  const key = requireSessionKey(sessionKey);
  return (queues.get(key)?.queue.length ?? 0) > 0;
}

export function resetSystemEventQueueForTest(): void {
  queues.clear();
}
