import type { JsonlWriter } from "../io/jsonlWriter.js";
import type { IngestionAdapter } from "../core/adapter.js";
import type { EmitFn } from "../core/adapter.js";

type SlackIngestorDeps = {
  adapter: IngestionAdapter;
  writer: JsonlWriter;
};

export class SlackIngestor {
  private readonly adapter: IngestionAdapter;
  private readonly writer: JsonlWriter;
  private started = false;

  constructor(deps: SlackIngestorDeps) {
    this.adapter = deps.adapter;
    this.writer = deps.writer;
  }

  async start(): Promise<void> {
    if (this.started) return;
    const emit: EmitFn = async (event) => {
      await this.writer.append(event);
    };
    await this.adapter.start(emit);
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    if (typeof this.adapter.stop === "function") {
      await this.adapter.stop();
    }
    this.started = false;
  }
}
