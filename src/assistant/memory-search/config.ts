import { join } from "node:path";
import type { MemorySearchRuntimeConfig } from "./types.js";

const DEFAULT_MODEL = "text-embedding-3-small";

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    return false;
  }
  return fallback;
}

function parseNumber(value: string | undefined, fallback: number, min: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, parsed);
}

export function resolveMemorySearchRuntimeConfig(params?: {
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string;
}): MemorySearchRuntimeConfig {
  const env = params?.env ?? process.env;
  const workspaceDir = params?.workspaceDir?.trim() || process.cwd();
  const dbPath =
    env.ADJUTANT_MEMORY_SEARCH_DB_PATH?.trim() ||
    join(workspaceDir, "memory", "index", "main.sqlite");

  return {
    enabled: parseBoolean(env.ADJUTANT_MEMORY_SEARCH_ENABLED, true),
    model: env.ADJUTANT_MEMORY_SEARCH_MODEL?.trim() || DEFAULT_MODEL,
    maxResults: Math.floor(parseNumber(env.ADJUTANT_MEMORY_SEARCH_MAX_RESULTS, 5, 1)),
    minScore: parseNumber(env.ADJUTANT_MEMORY_SEARCH_MIN_SCORE, 0, 0),
    vectorEnabled: parseBoolean(env.ADJUTANT_MEMORY_SEARCH_VECTOR_ENABLED, true),
    sqliteVecPath: env.ADJUTANT_MEMORY_SEARCH_SQLITE_VEC_PATH?.trim() || "",
    dbPath,
    chunkChars: Math.floor(parseNumber(env.ADJUTANT_MEMORY_SEARCH_CHUNK_CHARS, 1600, 256)),
    chunkOverlapChars: Math.floor(
      parseNumber(env.ADJUTANT_MEMORY_SEARCH_CHUNK_OVERLAP_CHARS, 320, 0)
    ),
    snippetMaxChars: Math.floor(parseNumber(env.ADJUTANT_MEMORY_SEARCH_SNIPPET_MAX_CHARS, 700, 80)),
    candidateMultiplier: parseNumber(env.ADJUTANT_MEMORY_SEARCH_CANDIDATE_MULTIPLIER, 3, 1),
    vectorWeight: parseNumber(env.ADJUTANT_MEMORY_SEARCH_VECTOR_WEIGHT, 0.7, 0),
    textWeight: parseNumber(env.ADJUTANT_MEMORY_SEARCH_TEXT_WEIGHT, 0.3, 0),
  };
}
