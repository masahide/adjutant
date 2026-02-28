import { buildDomCaptureExpression } from "./domCaptureScript.js";
import type { DomCaptureInput, DomCaptureStatus, DomSample } from "./domCaptureCore.js";

const DOM_ROOT_SELECTORS = [
  "[data-message-ts]",
  "[data-message-id]",
  '[data-qa="message"]',
  '[data-qa="message_container"]',
  '[data-qa="virtual-list-item"]',
  "[data-qa='message-pane-body'] [role='row']",
  ".p-message_pane_message",
  ".c-message_kit__message",
  ".p-threads_view__thread_container [role='presentation']",
];

const DOM_BODY_SELECTORS = [
  '[data-qa="message_content"]',
  '[data-qa="message-text"]',
  ".p-rich_text_section",
  ".c-message__body",
  ".p-message_pane_message__message",
  ".p-threads_view__thread_message_body",
  ".c-message_kit__text",
  ".p-rich_text_block",
];

const DOM_CHANNEL_NAME_SELECTORS = [
  '[data-qa="channel_name_text"]',
  ".p-top_nav__channel_header__name",
  ".p-top_nav__conversation_title__name",
  ".p-classic_nav__model__title__name",
  ".p-ia__channel_header__info .p-ia__channel_header__name",
  ".p-workspace_name",
  "[data-qa='channel_context_bar_channel_name']",
];

const DOM_RETRY_DELAYS_MS = [0, 100, 200, 300] as const;
const DOM_EXCERPT_LENGTH = 80;
const DOM_CACHE_MAX_ENTRIES = 200;

export type ReactionDomCandidate = {
  channelId?: string | null;
  frameId?: string;
  ts: string;
  normalizedTs: string;
};

type DomEvaluationSuccess = {
  ok: true;
  text: string;
  channelName?: string | null;
  channelId?: string | null;
  matchedTs?: string[];
};

type DomEvaluationFailureReason = DomCaptureStatus;

type DomEvaluationFailure = {
  ok: false;
  reason: DomEvaluationFailureReason;
  detail: {
    needles: string[];
    candidateCount?: number;
    sampleTs?: string[];
    samples?: DomSample[];
    hasBody?: boolean;
  };
};

type DomEvaluationOutcome = DomEvaluationSuccess | DomEvaluationFailure;

type StoredDomCapture = {
  text: string;
  channelName?: string | null;
  channelId?: string | null;
  capturedAt: number;
};

export type DomCaptureServiceOptions = {
  disabled: boolean;
  debugDetailed: boolean;
  evaluateInContext: (expression: string, contextId: number | null) => Promise<unknown>;
  resolveContextIds: (frameId?: string) => Array<number | null>;
  normalizedTimestamp: (ts: string | undefined) => string | null;
  toText: (value: unknown) => string | undefined;
  debugLog: (message: string, payload?: unknown) => void;
  resolveChannelName: (channelId: string | null | undefined) => string | undefined;
  cacheMessage: (channelId: string, ts: string, value: { text: string }) => void;
};

export class DomCaptureService {
  private readonly tasks: Map<string, Promise<void>> = new Map();
  private readonly byTs: Map<string, StoredDomCapture> = new Map();

  constructor(private readonly options: DomCaptureServiceOptions) {}

  async capture(candidate: ReactionDomCandidate): Promise<void> {
    if (this.options.disabled) return;
    const key = candidate.normalizedTs;
    if (!key) return;

    const existing = this.tasks.get(key);
    if (existing) {
      await existing.catch(() => {
        // upstream でログ済み
      });
      return;
    }

    const task = this.run(candidate).catch((err) => {
      this.options.debugLog("dom capture failed", err);
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
    if (!ts) return null;
    const normalized = this.options.normalizedTimestamp(ts);
    const keys = new Set<string>([ts]);
    if (normalized) keys.add(normalized);

    let entry: StoredDomCapture | null = null;
    for (const key of keys) {
      const stored = this.byTs.get(key);
      if (stored) entry = stored;
    }
    if (!entry) return null;

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
    const { ts, normalizedTs, channelId } = candidate;
    const variantSet = new Set<string>();
    if (ts) variantSet.add(ts);
    if (normalizedTs) variantSet.add(normalizedTs);
    const normalizedFromTs = this.options.normalizedTimestamp(ts);
    if (normalizedFromTs) variantSet.add(normalizedFromTs);
    const tsVariants = Array.from(variantSet).filter((value) => value.length > 0);
    if (tsVariants.length === 0) return;

    let lastFailure: DomEvaluationFailure | null = null;
    for (const delay of DOM_RETRY_DELAYS_MS) {
      if (delay > 0) await this.sleep(delay);
      const outcome = await this.evaluateDomForMessage(
        tsVariants,
        this.options.debugDetailed,
        candidate.frameId
      );
      if (!outcome) continue;
      if (!outcome.ok) {
        lastFailure = outcome;
        continue;
      }

      const text = this.options.toText(outcome.text);
      if (!text) continue;
      this.store(
        candidate,
        {
          text,
          channelName: outcome.channelName ?? channelId,
          channelId: outcome.channelId ?? channelId,
          matchedTs: outcome.matchedTs,
        },
        tsVariants
      );

      const channelKey = outcome.channelId ?? channelId ?? null;
      const channelLabel =
        outcome.channelName ??
        (channelKey ? (this.options.resolveChannelName(channelKey) ?? null) : null);
      if (channelKey) {
        this.options.cacheMessage(channelKey, normalizedTs, { text });
      }
      console.log(
        JSON.stringify({
          ok: true,
          ts: normalizedTs,
          channel: channelLabel ?? channelKey,
          excerpt: this.toExcerpt(text),
        })
      );
      return;
    }

    if (this.options.debugDetailed && lastFailure) {
      const payload: Record<string, unknown> = {
        ts: normalizedTs,
        reason: lastFailure.reason,
        needles: lastFailure.detail.needles,
        candidateCount: lastFailure.detail.candidateCount,
        sampleTs: lastFailure.detail.sampleTs,
        hasBody: lastFailure.detail.hasBody,
      };
      if (lastFailure.detail.samples) {
        payload.samples = lastFailure.detail.samples;
      }
      this.options.debugLog("dom capture failure", payload);
    }

    console.log(
      JSON.stringify({
        ok: false,
        ts: normalizedTs,
        channel: channelId ?? null,
        reason: "dom-not-found",
      })
    );
  }

  private async evaluateDomForMessage(
    tsList: string[],
    collectDebug: boolean,
    frameId?: string
  ): Promise<DomEvaluationOutcome | null> {
    const needles = tsList.filter((value) => typeof value === "string" && value.length > 0);
    if (needles.length === 0) return null;

    const input: DomCaptureInput = {
      tsList: needles,
      selectors: {
        root: DOM_ROOT_SELECTORS,
        body: DOM_BODY_SELECTORS,
        channel: DOM_CHANNEL_NAME_SELECTORS,
      },
      debugMode: collectDebug,
    };
    const expression = buildDomCaptureExpression(input);

    let lastFailure: DomEvaluationFailure | null = null;
    for (const contextId of this.options.resolveContextIds(frameId)) {
      try {
        const value = await this.options.evaluateInContext(expression, contextId);
        if (!value || typeof value !== "object") continue;
        const record = value as Record<string, unknown>;
        if ("error" in record && record.error) continue;

        if ("status" in record && typeof record.status === "string") {
          const reason = record.status as DomEvaluationFailureReason;
          const failure: DomEvaluationFailure = {
            ok: false,
            reason,
            detail: {
              needles,
              candidateCount: Number.isFinite(record.candidateCount as number)
                ? (record.candidateCount as number)
                : undefined,
              sampleTs: Array.isArray(record.sampleTs)
                ? (record.sampleTs as unknown[]).filter(
                    (entry): entry is string => typeof entry === "string" && entry.length > 0
                  )
                : undefined,
              samples:
                collectDebug && Array.isArray(record.samples)
                  ? (record.samples as DomSample[])
                  : undefined,
              hasBody:
                typeof record.hasBody === "boolean" ? (record.hasBody as boolean) : undefined,
            },
          };
          lastFailure = failure;
          continue;
        }

        const text = this.options.toText(record.text);
        if (!text) continue;
        const channelName = this.options.toText(record.channel);
        const channelId = this.options.toText(record.channelId);
        const matchedTs = Array.isArray(record.matchedTs)
          ? (record.matchedTs as unknown[]).filter(
              (entry): entry is string => typeof entry === "string" && entry.length > 0
            )
          : undefined;

        return {
          ok: true,
          text,
          channelName: channelName ?? null,
          channelId: channelId ?? null,
          matchedTs,
        };
      } catch {
        // ignore context evaluation errors
      }
    }

    return lastFailure;
  }

  private store(
    candidate: ReactionDomCandidate,
    data: {
      text: string;
      channelName?: string | null;
      channelId?: string | null;
      matchedTs?: string[];
    },
    variants: string[]
  ): void {
    const entry: StoredDomCapture = {
      text: data.text,
      channelName: data.channelName ?? null,
      channelId: data.channelId ?? null,
      capturedAt: Date.now(),
    };

    const keys = new Set<string>();
    keys.add(candidate.normalizedTs);
    keys.add(candidate.ts);
    for (const variant of variants) {
      if (variant) keys.add(variant);
    }
    if (Array.isArray(data.matchedTs)) {
      for (const value of data.matchedTs) {
        if (typeof value === "string" && value.length > 0) keys.add(value);
      }
    }
    for (const key of keys) {
      if (key) this.byTs.set(key, entry);
    }

    this.pruneCache();
  }

  private pruneCache(): void {
    if (this.byTs.size <= DOM_CACHE_MAX_ENTRIES) return;
    const entries = Array.from(this.byTs.entries()).sort(
      (a, b) => a[1].capturedAt - b[1].capturedAt
    );
    while (this.byTs.size > DOM_CACHE_MAX_ENTRIES && entries.length > 0) {
      const [key] = entries.shift() ?? [];
      if (key) {
        this.byTs.delete(key);
      }
    }
  }

  private toExcerpt(text: string): string {
    if (text.length <= DOM_EXCERPT_LENGTH) return text;
    return `${text.slice(0, DOM_EXCERPT_LENGTH)}...`;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }
}
