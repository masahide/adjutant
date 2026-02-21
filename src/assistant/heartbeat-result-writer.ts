import type { HeartbeatEventPayload, HeartbeatRunRecord, HeartbeatRunResult } from "./types.js";

type AppendRunRecordFn = (dataDir: string, record: HeartbeatRunRecord) => Promise<void>;
type EmitHeartbeatEventFn = (payload: HeartbeatEventPayload) => void;
type NowFn = () => Date;

export type FinalizeHeartbeatRunOptions = {
  dataDir: string;
  runAt: Date;
  sessionKey: string;
  triggerReason?: string;
  result: HeartbeatRunResult;
  event: Omit<HeartbeatEventPayload, "ts"> & { ts?: number };
  record?: {
    modelId?: string;
    preview?: string;
  };
};

function buildHeartbeatRunRecord(params: {
  runAt: Date;
  sessionKey: string;
  result: HeartbeatRunResult;
  triggerReason?: string;
  modelId?: string;
  preview?: string;
}): HeartbeatRunRecord {
  return {
    schema: "adjutant.heartbeat.result.v1",
    runAt: params.runAt.toISOString(),
    sessionKey: params.sessionKey,
    result: params.result,
    triggerReason: params.triggerReason,
    modelId: params.modelId,
    preview: params.preview,
  };
}

export class HeartbeatResultWriter {
  constructor(
    private readonly deps: {
      now: NowFn;
      emitHeartbeatEvent: EmitHeartbeatEventFn;
      appendRunRecord: AppendRunRecordFn;
      onWarn?: (message: string, meta?: Record<string, unknown>) => void;
    }
  ) {}

  async finalize(options: FinalizeHeartbeatRunOptions): Promise<HeartbeatRunResult> {
    this.deps.emitHeartbeatEvent({
      ts: options.event.ts ?? this.deps.now().getTime(),
      ...options.event,
    });
    const record = buildHeartbeatRunRecord({
      runAt: options.runAt,
      sessionKey: options.sessionKey,
      result: options.result,
      triggerReason: options.triggerReason,
      modelId: options.record?.modelId,
      preview: options.record?.preview,
    });
    try {
      await this.deps.appendRunRecord(options.dataDir, record);
    } catch (error) {
      this.deps.onWarn?.("failed to append run record", {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    return options.result;
  }
}
