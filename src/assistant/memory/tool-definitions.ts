import type { ToolDefinition } from "@mariozechner/pi-coding-agent";

import { jsonToolResult } from "./json-tool-result.js";
import { getOrCreateMemorySqliteIndex } from "./sqlite-index.js";
import type {
  MemoryGetErrorPayload,
  MemorySearchErrorPayload,
  MemorySearchRuntimeConfig,
} from "./types.js";

function readStringParam(
  params: Record<string, unknown>,
  key: string,
  required = false
): string | undefined {
  const value = params[key];
  if (typeof value !== "string") {
    if (required) {
      throw new Error(`${key} required`);
    }
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    if (required) {
      throw new Error(`${key} required`);
    }
    return undefined;
  }
  return trimmed;
}

function readNumberParam(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

export function createMemoryToolDefinitions(params: {
  workspaceDir: string;
  config: MemorySearchRuntimeConfig;
  onWarn?: (message: string, meta?: Record<string, unknown>) => void;
}): ToolDefinition[] {
  if (!params.config.enabled) {
    return [];
  }

  const memorySearchTool: ToolDefinition = {
    name: "memory_search",
    label: "Memory Search",
    description: "Search MEMORY.md and memory/*.md, returning snippets with path and line range.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1 },
        maxResults: { type: "number" },
        minScore: { type: "number" },
      },
      required: ["query"],
      additionalProperties: false,
    } as never,
    execute: async (_toolCallId, rawParams) => {
      try {
        const paramsRecord = (rawParams ?? {}) as Record<string, unknown>;
        const query = readStringParam(paramsRecord, "query", true) ?? "";
        const maxResults = readNumberParam(paramsRecord, "maxResults");
        const minScore = readNumberParam(paramsRecord, "minScore");
        const manager = getOrCreateMemorySqliteIndex({
          workspaceDir: params.workspaceDir,
          config: params.config,
        });
        const result = await manager.search(query, { maxResults, minScore });
        return jsonToolResult(result);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        params.onWarn?.("memory_search failed", { reason });
        const payload: MemorySearchErrorPayload = {
          results: [],
          disabled: true,
          error: reason,
        };
        return jsonToolResult(payload);
      }
    },
  };

  const memoryGetTool: ToolDefinition = {
    name: "memory_get",
    label: "Memory Get",
    description: "Read specific lines from MEMORY.md or memory/*.md after memory_search.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1 },
        from: { type: "number" },
        lines: { type: "number" },
      },
      required: ["path"],
      additionalProperties: false,
    } as never,
    execute: async (_toolCallId, rawParams) => {
      const paramsRecord = (rawParams ?? {}) as Record<string, unknown>;
      const path = readStringParam(paramsRecord, "path", true) ?? "";
      try {
        const manager = getOrCreateMemorySqliteIndex({
          workspaceDir: params.workspaceDir,
          config: params.config,
        });
        const from = readNumberParam(paramsRecord, "from");
        const lines = readNumberParam(paramsRecord, "lines");
        const result = await manager.readFile({
          relPath: path,
          from: from !== undefined ? Math.floor(from) : undefined,
          lines: lines !== undefined ? Math.floor(lines) : undefined,
        });
        return jsonToolResult(result);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        params.onWarn?.("memory_get failed", { reason, path });
        const payload: MemoryGetErrorPayload = {
          path,
          text: "",
          disabled: true,
          error: reason,
        };
        return jsonToolResult(payload);
      }
    },
  };

  return [memorySearchTool, memoryGetTool];
}
