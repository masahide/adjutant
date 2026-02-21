import { join } from "node:path";
import { parseBooleanEnv, parseNumberEnv, parseStringEnv } from "../../runtime/env-parsers.js";
import type { MemorySearchRuntimeConfig } from "./types.js";

const DEFAULT_MODEL = "text-embedding-3-small";

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
    enabled: parseBooleanEnv(env.ADJUTANT_MEMORY_SEARCH_ENABLED, true),
    model: parseStringEnv(env.ADJUTANT_MEMORY_SEARCH_MODEL, DEFAULT_MODEL),
    maxResults: Math.floor(parseNumberEnv(env.ADJUTANT_MEMORY_SEARCH_MAX_RESULTS, 5, { min: 1 })),
    minScore: parseNumberEnv(env.ADJUTANT_MEMORY_SEARCH_MIN_SCORE, 0, { min: 0 }),
    vectorEnabled: parseBooleanEnv(env.ADJUTANT_MEMORY_SEARCH_VECTOR_ENABLED, true),
    sqliteVecPath: env.ADJUTANT_MEMORY_SEARCH_SQLITE_VEC_PATH?.trim() || "",
    dbPath,
    chunkChars: Math.floor(
      parseNumberEnv(env.ADJUTANT_MEMORY_SEARCH_CHUNK_CHARS, 1600, { min: 256 })
    ),
    chunkOverlapChars: Math.floor(
      parseNumberEnv(env.ADJUTANT_MEMORY_SEARCH_CHUNK_OVERLAP_CHARS, 320, { min: 0 })
    ),
    snippetMaxChars: Math.floor(
      parseNumberEnv(env.ADJUTANT_MEMORY_SEARCH_SNIPPET_MAX_CHARS, 700, { min: 80 })
    ),
    candidateMultiplier: parseNumberEnv(env.ADJUTANT_MEMORY_SEARCH_CANDIDATE_MULTIPLIER, 3, {
      min: 1,
    }),
    vectorWeight: parseNumberEnv(env.ADJUTANT_MEMORY_SEARCH_VECTOR_WEIGHT, 0.7, { min: 0 }),
    textWeight: parseNumberEnv(env.ADJUTANT_MEMORY_SEARCH_TEXT_WEIGHT, 0.3, { min: 0 }),
  };
}
