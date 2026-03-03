import type { NormalizedEvent } from "../core/events.js";
import type { JsonlWriter } from "./jsonl-writer.js";
import type { SlackAdapter } from "./slack-adapter.js";

export type SlackIngestorOptions = {
  adapter: SlackAdapter;
  writer: JsonlWriter;
  onEvent?: (event: NormalizedEvent) => Promise<void> | void;
};

export class SlackIngestor {
  constructor(private readonly options: SlackIngestorOptions) {}

  async start(): Promise<void> {
    await this.options.adapter.start(async (event) => {
      await this.options.writer.append(event);
      await this.options.onEvent?.(event);
    });
  }

  async stop(): Promise<void> {
    await this.options.adapter.stop();
  }
}
