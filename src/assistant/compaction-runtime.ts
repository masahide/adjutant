import type { ContextUsage } from "@mariozechner/pi-coding-agent";
import { parseBooleanEnv, parseNonNegativeIntEnv } from "../runtime/env-parsers.js";

export const DEFAULT_COMPACTION_ENABLED = true;
export const DEFAULT_MEMORY_FLUSH_ENABLED = true;
export const DEFAULT_COMPACTION_RESERVE_TOKENS_FLOOR = 20_000;
export const DEFAULT_MEMORY_FLUSH_SOFT_THRESHOLD_TOKENS = 4_000;

export const DEFAULT_MEMORY_FLUSH_PROMPT = [
  "Pre-compaction memory flush.",
  "Store durable memories now (use memory/YYYY-MM-DD.md; create memory/ if needed).",
  "If nothing to store, reply with NO_REPLY.",
].join(" ");

export const DEFAULT_MEMORY_FLUSH_SYSTEM_PROMPT = [
  "Pre-compaction memory flush turn.",
  "The session is near auto-compaction; capture durable memories to disk.",
  "You may reply, but usually NO_REPLY is correct.",
].join(" ");

export type PreCompactionFlushSettings = {
  enabled: boolean;
  softThresholdTokens: number;
  reserveTokensFloor: number;
  prompt: string;
  systemPrompt: string;
};

export type CompactionRuntimeSettings = {
  compactionEnabled: boolean;
  memoryFlush: PreCompactionFlushSettings;
};

export type SessionCompactionMetadata = {
  compactionCount: number;
  memoryFlushCompactionCount: number | null;
};

export type CompactionReason = "threshold" | "overflow";

export type CompactionRuntimeState = {
  compactionCountAtStart: number;
  didCompactionComplete: boolean;
  compactionReason?: CompactionReason;
  flushTriggered: boolean;
  contextTokens: number | null;
  contextWindowTokens: number | null;
};

export type MemoryFlushDecision =
  | {
      shouldRun: true;
      tokens: number;
      thresholdTokens: number;
      contextWindowTokens: number;
    }
  | {
      shouldRun: false;
      reason:
        | "disabled"
        | "spoke"
        | "heartbeat"
        | "read-only"
        | "tokens-unavailable"
        | "threshold-invalid"
        | "below-threshold"
        | "already-flushed";
      tokens?: number | null;
      thresholdTokens?: number;
      contextWindowTokens?: number | null;
    };

function parseStoredCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  const int = Math.floor(value);
  return int >= 0 ? int : 0;
}

function parseStoredOptionalCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const int = Math.floor(value);
  return int >= 0 ? int : null;
}

function ensureNoReplyHint(text: string): string {
  if (/\bNO_REPLY\b/.test(text)) {
    return text;
  }
  return `${text}\n\nIf no user-visible reply is needed, start with NO_REPLY.`;
}

export function resolveCompactionRuntimeSettings(
  env: NodeJS.ProcessEnv = process.env
): CompactionRuntimeSettings {
  const compactionEnabled = parseBooleanEnv(
    env.ADJUTANT_COMPACTION_ENABLED,
    DEFAULT_COMPACTION_ENABLED
  );
  const memoryFlushEnabled = parseBooleanEnv(
    env.ADJUTANT_MEMORY_FLUSH_ENABLED,
    DEFAULT_MEMORY_FLUSH_ENABLED
  );
  const reserveTokensFloor = parseNonNegativeIntEnv(
    env.ADJUTANT_COMPACTION_RESERVE_TOKENS_FLOOR,
    DEFAULT_COMPACTION_RESERVE_TOKENS_FLOOR
  );
  const softThresholdTokens = parseNonNegativeIntEnv(
    env.ADJUTANT_MEMORY_FLUSH_SOFT_THRESHOLD_TOKENS,
    DEFAULT_MEMORY_FLUSH_SOFT_THRESHOLD_TOKENS
  );
  const prompt = ensureNoReplyHint(
    env.ADJUTANT_MEMORY_FLUSH_PROMPT?.trim() || DEFAULT_MEMORY_FLUSH_PROMPT
  );
  const systemPrompt = ensureNoReplyHint(
    env.ADJUTANT_MEMORY_FLUSH_SYSTEM_PROMPT?.trim() || DEFAULT_MEMORY_FLUSH_SYSTEM_PROMPT
  );

  return {
    compactionEnabled,
    memoryFlush: {
      enabled: memoryFlushEnabled,
      softThresholdTokens,
      reserveTokensFloor,
      prompt,
      systemPrompt,
    },
  };
}

export function resolveSessionCompactionMetadata(
  entry: Record<string, unknown> | null | undefined
): SessionCompactionMetadata {
  return {
    compactionCount: parseStoredCount(entry?.compactionCount),
    memoryFlushCompactionCount: parseStoredOptionalCount(entry?.memoryFlushCompactionCount),
  };
}

function normalizeContextUsage(usage: ContextUsage | undefined): {
  tokens: number | null;
  contextWindowTokens: number | null;
} {
  if (!usage) {
    return { tokens: null, contextWindowTokens: null };
  }

  const tokens =
    typeof usage.tokens === "number" && Number.isFinite(usage.tokens)
      ? Math.max(0, Math.floor(usage.tokens))
      : null;
  const contextWindowTokens =
    typeof usage.contextWindow === "number" && Number.isFinite(usage.contextWindow)
      ? Math.max(0, Math.floor(usage.contextWindow))
      : null;

  return {
    tokens,
    contextWindowTokens,
  };
}

export function shouldRunPreCompactionMemoryFlush(params: {
  settings: PreCompactionFlushSettings;
  metadata: SessionCompactionMetadata;
  contextUsage: ContextUsage | undefined;
  isMainSession: boolean;
  isHeartbeat: boolean;
  workspaceWritable: boolean;
}): MemoryFlushDecision {
  if (!params.settings.enabled) {
    return { shouldRun: false, reason: "disabled" };
  }
  if (!params.isMainSession) {
    return { shouldRun: false, reason: "spoke" };
  }
  if (params.isHeartbeat) {
    return { shouldRun: false, reason: "heartbeat" };
  }
  if (!params.workspaceWritable) {
    return { shouldRun: false, reason: "read-only" };
  }

  const usage = normalizeContextUsage(params.contextUsage);
  if (
    usage.tokens === null ||
    usage.contextWindowTokens === null ||
    usage.contextWindowTokens <= 0
  ) {
    return {
      shouldRun: false,
      reason: "tokens-unavailable",
      tokens: usage.tokens,
      contextWindowTokens: usage.contextWindowTokens,
    };
  }

  const thresholdTokens = Math.max(
    0,
    usage.contextWindowTokens -
      params.settings.reserveTokensFloor -
      params.settings.softThresholdTokens
  );

  if (thresholdTokens <= 0) {
    return {
      shouldRun: false,
      reason: "threshold-invalid",
      tokens: usage.tokens,
      thresholdTokens,
      contextWindowTokens: usage.contextWindowTokens,
    };
  }

  if (usage.tokens < thresholdTokens) {
    return {
      shouldRun: false,
      reason: "below-threshold",
      tokens: usage.tokens,
      thresholdTokens,
      contextWindowTokens: usage.contextWindowTokens,
    };
  }

  if (params.metadata.memoryFlushCompactionCount === params.metadata.compactionCount) {
    return {
      shouldRun: false,
      reason: "already-flushed",
      tokens: usage.tokens,
      thresholdTokens,
      contextWindowTokens: usage.contextWindowTokens,
    };
  }

  return {
    shouldRun: true,
    tokens: usage.tokens,
    thresholdTokens,
    contextWindowTokens: usage.contextWindowTokens,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as Record<string, unknown>;
}

export type CompactionEventTracker = {
  onEvent: (event: unknown) => void;
  setContextUsage: (usage: ContextUsage | undefined) => void;
  markFlushTriggered: () => void;
  markCompactionCompleted: (reason: CompactionReason) => void;
  getCompactionCount: () => number;
  getContextSnapshot: () => { contextTokens: number | null; contextWindowTokens: number | null };
  snapshot: () => CompactionRuntimeState;
};

export function createCompactionEventTracker(
  initialCompactionCount: number
): CompactionEventTracker {
  const startCount = Math.max(0, Math.floor(initialCompactionCount));
  let completedCount = 0;
  let didCompactionComplete = false;
  let compactionReason: CompactionReason | undefined;
  let flushTriggered = false;
  let contextTokens: number | null = null;
  let contextWindowTokens: number | null = null;

  return {
    onEvent: (event) => {
      const record = asRecord(event);
      if (!record) {
        return;
      }
      const type = record?.type;
      if (type === "auto_compaction_start") {
        const reason = record.reason;
        if (reason === "threshold" || reason === "overflow") {
          compactionReason = reason;
        }
        return;
      }

      if (type !== "auto_compaction_end") {
        return;
      }

      const aborted = record.aborted;
      if (aborted === true) {
        return;
      }
      if (!("result" in (record ?? {})) || record?.result == null) {
        return;
      }

      completedCount += 1;
      didCompactionComplete = true;
    },
    setContextUsage: (usage) => {
      const normalized = normalizeContextUsage(usage);
      contextTokens = normalized.tokens;
      contextWindowTokens = normalized.contextWindowTokens;
    },
    markFlushTriggered: () => {
      flushTriggered = true;
    },
    markCompactionCompleted: (reason) => {
      completedCount += 1;
      didCompactionComplete = true;
      compactionReason = reason;
    },
    getCompactionCount: () => startCount + completedCount,
    getContextSnapshot: () => ({
      contextTokens,
      contextWindowTokens,
    }),
    snapshot: () => ({
      compactionCountAtStart: startCount,
      didCompactionComplete,
      compactionReason,
      flushTriggered,
      contextTokens,
      contextWindowTokens,
    }),
  };
}
