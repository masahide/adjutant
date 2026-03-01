import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { MemorySearchRuntimeConfig } from "./types.js";

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true") {
    return true;
  }
  if (normalized === "0" || normalized === "false") {
    return false;
  }
  return fallback;
}

function parseNumber(value: string | undefined, fallback: number, min: number): number {
  if (typeof value !== "string" || value.trim().length === 0) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, parsed);
}

export function resolveMemorySearchRuntimeConfig(params?: {
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  agentId?: string;
}): MemorySearchRuntimeConfig {
  const env = params?.env ?? process.env;
  const stateDir =
    params?.stateDir ??
    (typeof env.ADJUTANT_STATE_DIR === "string" && env.ADJUTANT_STATE_DIR.trim().length > 0
      ? resolve(env.ADJUTANT_STATE_DIR.trim())
      : resolve(homedir(), ".adjutant"));
  const agentId = params?.agentId ?? "main";
  const dbPath =
    typeof env.ADJUTANT_MEMORY_SEARCH_DB_PATH === "string" &&
    env.ADJUTANT_MEMORY_SEARCH_DB_PATH.trim().length > 0
      ? resolve(env.ADJUTANT_MEMORY_SEARCH_DB_PATH.trim())
      : join(stateDir, "memory", `${agentId}.sqlite`);

  return {
    enabled: parseBoolean(env.ADJUTANT_MEMORY_SEARCH_ENABLED, true),
    dbPath,
    maxResults: Math.floor(parseNumber(env.ADJUTANT_MEMORY_SEARCH_MAX_RESULTS, 5, 1)),
    minScore: parseNumber(env.ADJUTANT_MEMORY_SEARCH_MIN_SCORE, 0, 0),
  };
}
