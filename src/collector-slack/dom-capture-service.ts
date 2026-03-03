const DOM_RETRY_DELAYS_MS = [0, 100, 200, 300] as const;
const DOM_CACHE_MAX_ENTRIES = 200;

export type ReactionDomCandidate = {
  channelId?: string | null;
  frameId?: string;
  ts: string;
  normalizedTs: string;
};

type StoredDomCapture = {
  text: string;
  channelName?: string | null;
  channelId?: string | null;
  capturedAt: number;
};

type DomCaptureFailure = {
  status: string;
  sampleTs?: string[];
};

type DomCaptureSuccess = {
  text: string;
  channel?: string | null;
  channelName?: string | null;
  channelId?: string | null;
  matchedTs?: string[];
};

type DomCaptureServiceOptions = {
  disabled: boolean;
  debugDetailed: boolean;
  resolveContextIds: (frameId?: string) => Array<number | null>;
  evaluateInContext: (expression: string, contextId: number | null) => Promise<unknown>;
  normalizedTimestamp: (ts: string | undefined) => string | null;
  toText: (value: unknown) => string | undefined;
  debugLog: (message: string, payload?: unknown) => void;
  resolveChannelName: (channelId: string | null | undefined) => string | undefined;
  cacheMessage: (channelId: string, ts: string, value: { text: string }) => void;
  sleep?: (ms: number) => Promise<void>;
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export class DomCaptureService {
  private readonly tasks = new Map<string, Promise<void>>();
  private readonly byTs = new Map<string, StoredDomCapture>();
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: DomCaptureServiceOptions) {
    this.sleep = options.sleep ?? defaultSleep;
  }

  async capture(candidate: ReactionDomCandidate): Promise<void> {
    if (this.options.disabled) {
      return;
    }
    const key = candidate.normalizedTs;
    if (!key) {
      return;
    }

    const existing = this.tasks.get(key);
    if (existing !== undefined) {
      await existing.catch(() => {
        // already logged by runner
      });
      return;
    }

    const task = this.run(candidate).catch((error) => {
      this.options.debugLog("dom capture failed", error);
    });
    this.tasks.set(key, task);
    try {
      await task;
    } finally {
      this.tasks.delete(key);
    }
  }

  consume(
    ts: string | undefined
  ): { text?: string; channelName?: string | null; channelId?: string | null } | null {
    if (!ts) {
      return null;
    }
    const normalized = this.options.normalizedTimestamp(ts);
    const keys = new Set<string>([ts]);
    if (normalized) {
      keys.add(normalized);
    }

    let entry: StoredDomCapture | undefined;
    for (const key of keys) {
      const current = this.byTs.get(key);
      if (current !== undefined) {
        entry = current;
      }
    }
    if (entry === undefined) {
      return null;
    }
    for (const key of keys) {
      this.byTs.delete(key);
    }
    return {
      text: entry.text,
      channelName: entry.channelName ?? undefined,
      channelId: entry.channelId ?? undefined,
    };
  }

  private async run(candidate: ReactionDomCandidate): Promise<void> {
    const tsVariants = this.collectTsVariants(candidate);
    if (tsVariants.length === 0) {
      return;
    }

    let lastFailure: DomCaptureFailure | null = null;
    for (const delayMs of DOM_RETRY_DELAYS_MS) {
      if (delayMs > 0) {
        await this.sleep(delayMs);
      }
      const outcome = await this.evaluateDom(candidate, tsVariants);
      if (outcome === undefined) {
        continue;
      }

      if ("status" in outcome) {
        lastFailure = outcome;
        continue;
      }

      const text = this.options.toText(outcome.text);
      if (!text) {
        continue;
      }

      const channelId = asString(outcome.channelId) ?? asString(candidate.channelId ?? undefined);
      const channelName =
        asString(outcome.channelName) ??
        asString(outcome.channel) ??
        (channelId ? this.options.resolveChannelName(channelId) : undefined);
      this.storeCapture(candidate, text, channelName, channelId, outcome.matchedTs, tsVariants);

      if (channelId !== undefined) {
        this.options.cacheMessage(channelId, candidate.normalizedTs, { text });
      }
      return;
    }

    if (this.options.debugDetailed && lastFailure !== null) {
      this.options.debugLog("dom capture failure", {
        ts: candidate.normalizedTs,
        reason: lastFailure.status,
        sampleTs: lastFailure.sampleTs,
      });
    }
  }

  private collectTsVariants(candidate: ReactionDomCandidate): string[] {
    const variants = new Set<string>();
    if (candidate.ts) {
      variants.add(candidate.ts);
    }
    if (candidate.normalizedTs) {
      variants.add(candidate.normalizedTs);
    }
    const normalizedFromTs = this.options.normalizedTimestamp(candidate.ts);
    if (normalizedFromTs) {
      variants.add(normalizedFromTs);
    }
    return [...variants].filter((value) => value.length > 0);
  }

  private async evaluateDom(
    candidate: ReactionDomCandidate,
    tsVariants: string[]
  ): Promise<DomCaptureSuccess | DomCaptureFailure | undefined> {
    const expression = `/* dom-capture ${JSON.stringify({
      ts: tsVariants,
      channelId: candidate.channelId ?? null,
    })} */`;

    let lastFailure: DomCaptureFailure | undefined;
    for (const contextId of this.options.resolveContextIds(candidate.frameId)) {
      try {
        const raw = await this.options.evaluateInContext(expression, contextId);
        if (!isObject(raw)) {
          continue;
        }
        if (typeof raw.status === "string") {
          lastFailure = {
            status: raw.status,
            sampleTs: Array.isArray(raw.sampleTs)
              ? raw.sampleTs.filter((item): item is string => typeof item === "string")
              : undefined,
          };
          continue;
        }
        const text = this.options.toText(raw.text);
        if (!text) {
          continue;
        }
        return {
          text,
          channel: asString(raw.channel),
          channelName: asString(raw.channelName),
          channelId: asString(raw.channelId),
          matchedTs: Array.isArray(raw.matchedTs)
            ? raw.matchedTs.filter((item): item is string => typeof item === "string")
            : undefined,
        };
      } catch {
        // ignore evaluation failure for this context
      }
    }
    return lastFailure;
  }

  private storeCapture(
    candidate: ReactionDomCandidate,
    text: string,
    channelName: string | undefined,
    channelId: string | undefined,
    matchedTs: string[] | undefined,
    tsVariants: string[]
  ): void {
    const entry: StoredDomCapture = {
      text,
      channelName: channelName ?? null,
      channelId: channelId ?? null,
      capturedAt: Date.now(),
    };
    const keys = new Set<string>([candidate.ts, candidate.normalizedTs, ...tsVariants]);
    if (Array.isArray(matchedTs)) {
      for (const ts of matchedTs) {
        if (ts) {
          keys.add(ts);
        }
      }
    }
    for (const key of keys) {
      if (key) {
        this.byTs.set(key, entry);
      }
    }
    this.evictIfNeeded();
  }

  private evictIfNeeded(): void {
    if (this.byTs.size <= DOM_CACHE_MAX_ENTRIES) {
      return;
    }
    const entries = [...this.byTs.entries()].sort((a, b) => a[1].capturedAt - b[1].capturedAt);
    const removeCount = this.byTs.size - DOM_CACHE_MAX_ENTRIES;
    for (let i = 0; i < removeCount; i += 1) {
      const row = entries[i];
      if (row) {
        this.byTs.delete(row[0]);
      }
    }
  }
}
