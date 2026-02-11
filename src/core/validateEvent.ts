import type { NormalizedEvent } from "./events.js";

export function isNormalizedEvent(input: unknown): input is NormalizedEvent {
  if (!input || typeof input !== "object") return false;
  const event = input as Record<string, unknown>;

  if (event.schema !== "reaclog.event.v1.1") return false;
  if (typeof event.uid !== "string" || !event.uid) return false;
  if (event.source !== "slack" && event.source !== "github" && event.source !== "git-local")
    return false;
  if (typeof event.kind !== "string" || !event.kind) return false;
  if (typeof event.ts !== "string" || !event.ts.includes("T")) return false;

  if ("detail" in event && event.detail !== undefined && typeof event.detail !== "object") {
    return false;
  }
  return true;
}
