import type { ClientNotification } from "../../contracts/acp/rpc-types.js";

export interface ToolEventBridgeRecord {
  runId: string;
  sessionId: string;
  toolCallId: string;
  title?: string;
  kind?: string;
  status?: "pending" | "in_progress" | "completed" | "failed";
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: unknown;
  updatedAt: string;
}

export interface ToolEventBridgeOptions {
  resolveRunId: (sessionId: string) => string | undefined;
  now?: () => string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export class ToolEventBridge {
  private readonly byRunId = new Map<string, Map<string, ToolEventBridgeRecord>>();
  private readonly resolveRunId: ToolEventBridgeOptions["resolveRunId"];
  private readonly now: () => string;

  constructor(options: ToolEventBridgeOptions) {
    this.resolveRunId = options.resolveRunId;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  ingest(notification: ClientNotification): ToolEventBridgeRecord | undefined {
    const update = notification.params.update;
    if (!isObject(update)) {
      return undefined;
    }

    const sessionUpdate = getString(update.sessionUpdate);
    if (sessionUpdate !== "tool_call" && sessionUpdate !== "tool_call_update") {
      return undefined;
    }

    const sessionId = notification.params.sessionId;
    const runId = this.resolveRunId(sessionId);
    if (runId === undefined) {
      return undefined;
    }

    const toolCallId = getString(update.toolCallId);
    if (toolCallId === undefined) {
      return undefined;
    }

    const runMap = this.byRunId.get(runId) ?? new Map<string, ToolEventBridgeRecord>();
    const current = runMap.get(toolCallId);

    const next: ToolEventBridgeRecord = {
      runId,
      sessionId,
      toolCallId,
      title: getString(update.title) ?? current?.title,
      kind: getString(update.kind) ?? current?.kind,
      status: this.normalizeStatus(update.status) ?? current?.status,
      rawInput: update.rawInput ?? current?.rawInput,
      rawOutput: update.rawOutput ?? current?.rawOutput,
      content: update.content ?? current?.content,
      updatedAt: this.now(),
    };

    if (this.isDuplicate(current, next)) {
      return current;
    }

    runMap.set(toolCallId, next);
    this.byRunId.set(runId, runMap);
    return next;
  }

  listRun(runId: string): ToolEventBridgeRecord[] {
    const runMap = this.byRunId.get(runId);
    if (runMap === undefined) {
      return [];
    }

    return [...runMap.values()].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  }

  private normalizeStatus(value: unknown): ToolEventBridgeRecord["status"] {
    if (
      value === "pending" ||
      value === "in_progress" ||
      value === "completed" ||
      value === "failed"
    ) {
      return value;
    }
    return undefined;
  }

  private isDuplicate(
    prev: ToolEventBridgeRecord | undefined,
    next: ToolEventBridgeRecord
  ): prev is ToolEventBridgeRecord {
    if (prev === undefined) {
      return false;
    }

    return (
      prev.title === next.title &&
      prev.kind === next.kind &&
      prev.status === next.status &&
      JSON.stringify(prev.rawInput) === JSON.stringify(next.rawInput) &&
      JSON.stringify(prev.rawOutput) === JSON.stringify(next.rawOutput) &&
      JSON.stringify(prev.content) === JSON.stringify(next.content)
    );
  }
}
