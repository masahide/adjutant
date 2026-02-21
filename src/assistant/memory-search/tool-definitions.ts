import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { resolveMemorySearchRuntimeConfig } from "./config.js";
import { normalizeMemorySearchError } from "./errors.js";
import { jsonToolResult } from "./json-tool-result.js";
import { getOrCreateMemorySearchManager } from "./manager.js";
import type {
  EmbeddingProvider,
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
  if (!trimmed) {
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

type MemoryToolFactoryOptions = {
  workspaceDir: string;
  config?: MemorySearchRuntimeConfig;
  embeddingProvider?: EmbeddingProvider;
  onWarn?: (message: string, meta?: Record<string, unknown>) => void;
};

export function createMemoryToolDefinitions(params: MemoryToolFactoryOptions): ToolDefinition[] {
  const config =
    params.config ?? resolveMemorySearchRuntimeConfig({ workspaceDir: params.workspaceDir });
  if (!config.enabled) {
    return [];
  }

  const memorySearchTool: ToolDefinition = {
    name: "memory_search",
    label: "Memory Search",
    description:
      "Search MEMORY.md and memory/*.md using hybrid BM25 and vector ranking, returning snippet + path + line range.",
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
        const query = readStringParam(paramsRecord, "query", true);
        const maxResults = readNumberParam(paramsRecord, "maxResults");
        const minScore = readNumberParam(paramsRecord, "minScore");
        const manager = await getOrCreateMemorySearchManager({
          workspaceDir: params.workspaceDir,
          config,
          embeddingProvider: params.embeddingProvider,
        });
        const result = await manager.search(query ?? "", {
          maxResults,
          minScore,
        });
        return jsonToolResult({
          results: result.results,
          provider: result.provider,
          model: result.model,
          ...(result.fallback ? { fallback: result.fallback } : {}),
        });
      } catch (error) {
        const normalized = normalizeMemorySearchError(error);
        params.onWarn?.("memory_search failed", {
          code: normalized.code,
          reason: normalized.message,
        });
        const payload: MemorySearchErrorPayload = {
          results: [],
          disabled: true,
          error: normalized.message,
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
        const manager = await getOrCreateMemorySearchManager({
          workspaceDir: params.workspaceDir,
          config,
          embeddingProvider: params.embeddingProvider,
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
        const normalized = normalizeMemorySearchError(error);
        params.onWarn?.("memory_get failed", {
          code: normalized.code,
          reason: normalized.message,
          path,
        });
        const payload: MemoryGetErrorPayload = {
          path,
          text: "",
          disabled: true,
          error: normalized.message,
        };
        return jsonToolResult(payload);
      }
    },
  };

  return [memorySearchTool, memoryGetTool];
}
