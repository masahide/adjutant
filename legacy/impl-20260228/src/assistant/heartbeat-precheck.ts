import type { HeartbeatRunResult } from "./types.js";

export type HeartbeatCheckFn = () => Promise<HeartbeatRunResult | null>;

export class HeartbeatPrecheck {
  constructor(private readonly checks: HeartbeatCheckFn[]) {}

  async evaluate(): Promise<HeartbeatRunResult | null> {
    for (const check of this.checks) {
      const result = await check();
      if (result) {
        return result;
      }
    }
    return null;
  }
}
