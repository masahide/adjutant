import type { PendingPermission } from "../acp/permission-registry.js";
import {
  toPermissionSummary,
  type RunSummary,
  type SnapshotResponse,
} from "../contracts/http-api.js";

interface ToolEventInput {
  runId: string;
  sessionId: string;
  toolCallId: string;
  status?: "pending" | "in_progress" | "completed" | "failed";
  title?: string;
  kind?: string;
  updatedAt: string;
}

export interface SnapshotBuildDeps {
  runById: Map<string, RunSummary>;
  listToolEvents: (runId: string) => ToolEventInput[];
  listPendingPermissions: () => PendingPermission[];
}

export function buildSnapshotResponse(deps: SnapshotBuildDeps): SnapshotResponse {
  const toolEventsByRun: SnapshotResponse["toolEventsByRun"] = {};
  for (const runId of deps.runById.keys()) {
    const records = deps
      .listToolEvents(runId)
      .filter(
        (record): record is ToolEventInput & { status: NonNullable<ToolEventInput["status"]> } => {
          return record.status !== undefined;
        }
      )
      .map((record) => ({
        runId: record.runId,
        sessionId: record.sessionId,
        toolCallId: record.toolCallId,
        status: record.status,
        title: record.title,
        kind: record.kind,
        updatedAt: record.updatedAt,
      }));
    toolEventsByRun[runId] = records;
  }

  return {
    runs: [...deps.runById.values()].sort((a, b) => a.acceptedAt.localeCompare(b.acceptedAt)),
    toolEventsByRun,
    pendingPermissions: deps.listPendingPermissions().map(toPermissionSummary),
  };
}
