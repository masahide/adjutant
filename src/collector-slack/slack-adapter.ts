import type { NormalizedEvent } from "../core/events.js";
import {
  normalizeAndDedupeSourceEvents,
  type CollectorSourceEnvelope,
  SlackUidDeduper,
} from "./source-normalizer.js";

export type EmitFn = (event: NormalizedEvent) => Promise<void> | void;

export class SlackAdapter {
  private emit: EmitFn | null = null;
  private readonly deduper = new SlackUidDeduper();

  async start(emit: EmitFn): Promise<void> {
    this.emit = emit;
  }

  async stop(): Promise<void> {
    this.emit = null;
  }

  async ingestSource(source: CollectorSourceEnvelope): Promise<void> {
    if (this.emit === null) {
      return;
    }
    const normalized = normalizeAndDedupeSourceEvents([source], this.deduper);
    for (const item of normalized) {
      await this.emit(item.event);
    }
  }

  async ingestSources(sources: readonly CollectorSourceEnvelope[]): Promise<void> {
    if (this.emit === null) {
      return;
    }
    const normalized = normalizeAndDedupeSourceEvents(sources, this.deduper);
    for (const item of normalized) {
      await this.emit(item.event);
    }
  }
}
