import type { ClientNotification } from "../../contracts/acp/rpc-types.js";
import { extractToolError, normalizeToolPayload } from "../http/tool-payload-normalizer.js";

export interface ToolEventBridgeRecord {
  runId: string;
  sessionId: string;
  toolCallId: string;
  title?: string;
  kind?: string;
  status?: "pending" | "in_progress" | "completed" | "failed";
  rawInput?: unknown;
  rawOutput?: unknown;
  error?: string;
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

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function toComparableJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '"[unserializable]"';
  }
}

function statusRank(value: ToolEventBridgeRecord["status"]): number {
  if (value === "pending") {
    return 1;
  }
  if (value === "in_progress") {
    return 2;
  }
  if (value === "completed" || value === "failed") {
    return 3;
  }
  return 0;
}

function mergeStatus(
  current: ToolEventBridgeRecord["status"],
  next: ToolEventBridgeRecord["status"]
): ToolEventBridgeRecord["status"] {
  if (next === undefined) {
    return current;
  }
  if (current === undefined) {
    return next;
  }
  if (statusRank(next) >= statusRank(current)) {
    return next;
  }
  return current;
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
    const status = mergeStatus(current?.status, this.normalizeStatus(update.status));
    const error = status === "failed" ? (extractToolError(update) ?? current?.error) : undefined;

    const next: ToolEventBridgeRecord = {
      runId,
      sessionId,
      toolCallId,
      title: getString(update.title) ?? current?.title,
      kind: getString(update.kind) ?? current?.kind,
      status,
      rawInput: hasOwn(update, "rawInput")
        ? normalizeToolPayload(update.rawInput)
        : current?.rawInput,
      rawOutput: hasOwn(update, "rawOutput")
        ? normalizeToolPayload(update.rawOutput)
        : current?.rawOutput,
      error,
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
      toComparableJson(prev.rawInput) === toComparableJson(next.rawInput) &&
      toComparableJson(prev.rawOutput) === toComparableJson(next.rawOutput) &&
      prev.error === next.error &&
      toComparableJson(prev.content) === toComparableJson(next.content)
    );
  }
}
