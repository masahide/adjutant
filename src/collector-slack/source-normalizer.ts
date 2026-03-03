import type { NormalizedEvent } from "../core/events.js";
import { isSlackNormalizedEvent } from "../core/events.js";

export type CollectorSourceKind = "fetch" | "websocket" | "response";

export type CollectorSourceEnvelope = {
  sourceKind: CollectorSourceKind;
  payload: unknown;
};

export type NormalizedSourceEnvelope = {
  sourceKind: CollectorSourceKind;
  event: NormalizedEvent;
};

export function normalizeCollectorSourceEnvelope(
  input: CollectorSourceEnvelope
): NormalizedSourceEnvelope | undefined {
  if (!isSlackNormalizedEvent(input.payload)) {
    return undefined;
  }
  return {
    sourceKind: input.sourceKind,
    event: input.payload,
  };
}

export class SlackUidDeduper {
  private readonly seen = new Set<string>();

  shouldEmit(event: NormalizedEvent): boolean {
    const uid = event.uid.trim();
    if (uid.length === 0) {
      return false;
    }
    if (this.seen.has(uid)) {
      return false;
    }
    this.seen.add(uid);
    return true;
  }

  size(): number {
    return this.seen.size;
  }

  reset(): void {
    this.seen.clear();
  }
}

export function normalizeAndDedupeSourceEvents(
  inputs: readonly CollectorSourceEnvelope[],
  deduper: SlackUidDeduper = new SlackUidDeduper()
): NormalizedSourceEnvelope[] {
  const output: NormalizedSourceEnvelope[] = [];
  for (const input of inputs) {
    const normalized = normalizeCollectorSourceEnvelope(input);
    if (normalized === undefined) {
      continue;
    }
    if (!deduper.shouldEmit(normalized.event)) {
      continue;
    }
    output.push(normalized);
  }
  return output;
}
