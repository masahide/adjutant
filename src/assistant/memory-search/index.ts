export { resolveMemorySearchRuntimeConfig } from "./config.js";
export {
  MemorySearchError,
  normalizeMemorySearchError,
  type MemorySearchErrorCode,
} from "./errors.js";
export { createMemoryToolDefinitions } from "./tool-definitions.js";
export { MemoryPathGuard } from "./path-guard.js";
export {
  MemorySearchManager,
  getOrCreateMemorySearchManager,
  clearMemorySearchManagerCacheForTest,
} from "./manager.js";
export type {
  EmbeddingProvider,
  MemoryChunk,
  MemoryFileRecord,
  MemoryGetErrorPayload,
  MemoryGetSuccessPayload,
  MemorySearchErrorPayload,
  MemorySearchResult,
  MemorySearchRuntimeConfig,
  MemorySearchSuccessPayload,
} from "./types.js";
