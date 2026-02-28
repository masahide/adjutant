import type { NormalizedEvent } from "./events.js";

export type EmitFn = (event: NormalizedEvent) => Promise<void>;

export interface IngestionAdapter {
  name: string;
  start(emit: EmitFn): Promise<void>;
  stop?(): Promise<void>;
}
