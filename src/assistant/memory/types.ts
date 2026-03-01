export type MemoryScope = "main" | "spoke";

export interface MemorySearchRuntimeConfig {
  enabled: boolean;
  dbPath: string;
  maxResults: number;
  minScore: number;
}

export interface MemorySearchResult {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: "memory";
}

export interface MemorySearchSuccessPayload {
  results: MemorySearchResult[];
  provider: string;
  model: string;
}

export interface MemorySearchErrorPayload {
  results: [];
  disabled: true;
  error?: string;
}

export interface MemoryGetSuccessPayload {
  path: string;
  text: string;
}

export interface MemoryGetErrorPayload {
  path: string;
  text: "";
  disabled: true;
  error?: string;
}
