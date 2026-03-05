import type { JournalRecord } from "../../runtime/journal-store.js";

export interface ReplaySource<T> {
  replayPending: () => Promise<JournalRecord<T>[]>;
}

export async function replayPendingRecords<T>(input: {
  source: ReplaySource<T>;
  apply: (record: JournalRecord<T>) => Promise<void> | void;
}): Promise<number> {
  const records = await input.source.replayPending();
  for (const record of records) {
    await input.apply(record);
  }
  return records.length;
}
