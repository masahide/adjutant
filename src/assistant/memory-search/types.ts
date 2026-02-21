export type MemorySearchSource = "memory";

export type MemorySearchResult = {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: MemorySearchSource;
  citation?: string;
};

export type MemorySearchSuccessPayload = {
  results: MemorySearchResult[];
  provider: string;
  model?: string;
  fallback?: {
    from: string;
    reason?: string;
  };
  citations?: "on" | "off" | "auto";
};

export type MemorySearchErrorPayload = {
  results: [];
  disabled: true;
  error?: string;
};

export type MemoryGetSuccessPayload = {
  path: string;
  text: string;
};

export type MemoryGetErrorPayload = {
  path: string;
  text: "";
  disabled: true;
  error?: string;
};

export type MemorySearchRuntimeConfig = {
  enabled: boolean;
  model: string;
  maxResults: number;
  minScore: number;
  vectorEnabled: boolean;
  sqliteVecPath: string;
  dbPath: string;
  chunkChars: number;
  chunkOverlapChars: number;
  snippetMaxChars: number;
  candidateMultiplier: number;
  vectorWeight: number;
  textWeight: number;
};

export type MemoryChunk = {
  startLine: number;
  endLine: number;
  text: string;
  hash: string;
};

export type MemoryFileRecord = {
  path: string;
  absPath: string;
  hash: string;
  mtimeMs: number;
  size: number;
  content: string;
};

export interface EmbeddingProvider {
  provider: string;
  model: string;
  embedTexts(texts: string[]): Promise<number[][]>;
  embedQuery(query: string): Promise<number[]>;
}
