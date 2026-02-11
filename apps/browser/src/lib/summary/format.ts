import { formatIsoTimestamp } from "$lib/format/date";

export function formatSummarySavedAt(savedAt: string | null | undefined): string | null {
  if (!savedAt) {
    return null;
  }
  return formatIsoTimestamp(savedAt);
}
