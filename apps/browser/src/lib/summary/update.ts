import type { SummaryUpdate } from "$lib/components/summary/types";

export function applySummaryUpdate(
  base: string,
  update: SummaryUpdate,
  overrideMode?: SummaryUpdate["mode"]
): string {
  const mode = overrideMode ?? update.mode;
  switch (mode) {
    case "replace":
      return update.content;
    case "append": {
      const parts = [base, update.content].filter((part) => part && part.length > 0);
      return parts.join(base && base.endsWith("\n") ? "" : "\n");
    }
    case "none":
    default:
      return base;
  }
}
