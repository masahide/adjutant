export type ExecutionContextDescription = {
  id: number;
  name: string;
  origin?: string;
  auxData?: {
    frameId?: string;
    type?: string;
    isDefault?: boolean;
  };
};

export type RuntimeExecutionContextCreatedEvent = {
  context: ExecutionContextDescription;
};

export type RuntimeExecutionContextDestroyedEvent = {
  executionContextId: number;
};

type FrameContextInfo = {
  default?: number;
  isolated?: number;
  other: number[];
};

export class RuntimeContextRegistry {
  private readonly contextsByFrame: Map<string, FrameContextInfo> = new Map();
  private readonly frameIdByContext: Map<number, string | null> = new Map();
  private defaultContextId: number | null = null;

  onCreated(event: RuntimeExecutionContextCreatedEvent): void {
    const context = event?.context;
    if (!context || typeof context.id !== "number") return;

    const frameId = context.auxData?.frameId ?? null;
    const type = context.auxData?.type;
    const isDefault = Boolean(context.auxData?.isDefault || type === "default");

    if (frameId) {
      const info: FrameContextInfo = this.contextsByFrame.get(frameId) ?? { other: [] };
      if (isDefault) {
        info.default = context.id;
        this.defaultContextId = context.id;
      } else if (type === "isolated") {
        info.isolated = context.id;
      } else if (!info.other.includes(context.id)) {
        info.other.push(context.id);
      }
      this.contextsByFrame.set(frameId, info);
    } else if (isDefault) {
      this.defaultContextId = context.id;
    }

    this.frameIdByContext.set(context.id, frameId);
  }

  onDestroyed(event: RuntimeExecutionContextDestroyedEvent): void {
    const contextId = event?.executionContextId;
    if (typeof contextId !== "number") return;

    const frameId = this.frameIdByContext.get(contextId);
    if (frameId) {
      const info = this.contextsByFrame.get(frameId);
      if (info) {
        if (info.default === contextId) delete info.default;
        if (info.isolated === contextId) delete info.isolated;
        info.other = info.other.filter((id) => id !== contextId);

        if (!info.default && !info.isolated && info.other.length === 0) {
          this.contextsByFrame.delete(frameId);
        } else {
          this.contextsByFrame.set(frameId, info);
        }
      }
    }

    this.frameIdByContext.delete(contextId);
    if (this.defaultContextId === contextId) {
      this.defaultContextId = null;
    }
  }

  resolveContextIds(frameId?: string): Array<number | null> {
    const result: Array<number | null> = [];

    if (frameId) {
      const info = this.contextsByFrame.get(frameId);
      if (info) {
        if (typeof info.default === "number") result.push(info.default);
        if (typeof info.isolated === "number" && !result.includes(info.isolated)) {
          result.push(info.isolated);
        }
        for (const id of info.other) {
          if (!result.includes(id)) result.push(id);
        }
      }
    }

    if (this.defaultContextId !== null && !result.includes(this.defaultContextId)) {
      result.push(this.defaultContextId);
    }

    result.push(null);
    return result;
  }
}
