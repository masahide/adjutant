type DedupeRecord = {
  dedupeKey: string;
  canonicalMessageId: string;
  payloadHash: string;
};

export class IngestDedupeStore {
  private readonly byKey = new Map<string, DedupeRecord>();

  get(dedupeKey: string): DedupeRecord | undefined {
    return this.byKey.get(dedupeKey);
  }

  put(record: DedupeRecord): void {
    this.byKey.set(record.dedupeKey, record);
  }

  size(): number {
    return this.byKey.size;
  }
}
