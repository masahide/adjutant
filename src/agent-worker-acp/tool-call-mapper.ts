import type { LegacyToolCallEvent } from "../assistant/agent-runner.js";
import type {
  ToolCallProgressUpdate,
  ToolCallStartUpdate,
  ToolKind,
  ToolStatus,
} from "./session-update-projector.js";

type LegacyStartEvent = Extract<LegacyToolCallEvent, { event: "tool_execution_start" }>;
type LegacyEndEvent = Extract<LegacyToolCallEvent, { event: "tool_execution_end" }>;

function sanitizeIdPart(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function toToolCallId(event: LegacyToolCallEvent): string {
  if (event.toolCallId !== undefined && event.toolCallId.length > 0) {
    return event.toolCallId;
  }

  const suffix =
    event.event === "tool_execution_start"
      ? (event.startedAt ?? Date.now().toString())
      : (event.endedAt ?? Date.now().toString());

  return `tool_${sanitizeIdPart(event.name)}_${sanitizeIdPart(suffix)}`;
}

function normalizeKind(kind: LegacyStartEvent["kind"]): ToolKind {
  if (kind === "read" || kind === "edit" || kind === "execute" || kind === "search") {
    return kind;
  }

  return "execute";
}

function normalizeFinalStatus(
  explicit: ToolStatus | undefined,
  fallback: LegacyEndEvent["status"]
): ToolStatus {
  if (explicit !== undefined) {
    return explicit;
  }

  if (fallback === "error") {
    return "failed";
  }

  return "completed";
}

export function mapToolExecutionStart(event: LegacyStartEvent): ToolCallStartUpdate {
  return {
    sessionUpdate: "tool_call",
    toolCallId: toToolCallId(event),
    title: event.title ?? event.name,
    kind: normalizeKind(event.kind),
    status: "pending",
    rawInput: event.rawInput,
  };
}

export function mapToolExecutionEnd(
  event: LegacyEndEvent,
  options: { status?: ToolStatus } = {}
): ToolCallProgressUpdate {
  const status = normalizeFinalStatus(options.status, event.status);

  return {
    sessionUpdate: "tool_call_update",
    toolCallId: toToolCallId(event),
    status,
    rawOutput: event.rawOutput,
    content:
      event.error === undefined
        ? undefined
        : [
            {
              type: "content",
              content: {
                type: "text",
                text: event.error,
              },
            },
          ],
  };
}
