import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemorySearchManager,
  normalizeMemorySearchError,
  clearMemorySearchManagerCacheForTest,
  resolveMemorySearchRuntimeConfig,
  type EmbeddingProvider,
} from "../../src/assistant/memory-search/index.js";

function toVector(text: string): number[] {
  let a = 0;
  let b = 0;
  let c = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    a += code % 7;
    b += code % 11;
    c += code % 13;
  }
  return [a / 1000, b / 1000, c / 1000];
}

function createFakeEmbeddingProvider(params?: { failQuery?: boolean }): EmbeddingProvider {
  return {
    provider: "openai",
    model: "text-embedding-3-small",
    embedTexts: async (texts) => texts.map((text) => toVector(text)),
    embedQuery: async (query) => {
      if (params?.failQuery) {
        throw new Error("query embedding timeout");
      }
      return toVector(query);
    },
  };
}

function createControlledEmbeddingProvider(params: {
  textToVector: (text: string) => number[];
  queryVector: number[] | null;
}): EmbeddingProvider {
  return {
    provider: "openai",
    model: "text-embedding-3-small",
    embedTexts: async (texts) => texts.map((text) => params.textToVector(text)),
    embedQuery: async () => {
      if (!params.queryVector) {
        throw new Error("embedding unavailable");
      }
      return params.queryVector;
    },
  };
}

describe("MemorySearchManager", () => {
  afterEach(async () => {
    await clearMemorySearchManagerCacheForTest();
  });

  it("MEMORY.md / memory/*.md を索引化して検索できる", async () => {
    const workspaceDir = await mkdtemp(`${tmpdir()}/adjutant-memory-search-`);
    try {
      await mkdir(join(workspaceDir, "memory"), { recursive: true });
      await writeFile(
        join(workspaceDir, "MEMORY.md"),
        "# Decisions\nUse proactive router with lightweight model first.",
        "utf8"
      );
      await writeFile(
        join(workspaceDir, "memory", "2026-02-21.md"),
        "Slack routing policy memo\nEscalate urgent alerts immediately.",
        "utf8"
      );

      const config = resolveMemorySearchRuntimeConfig({
        workspaceDir,
        env: {
          ...process.env,
          ADJUTANT_MEMORY_SEARCH_DB_PATH: join(workspaceDir, "memory", "index", "test.sqlite"),
          ADJUTANT_MEMORY_SEARCH_MODEL: "text-embedding-3-small",
          ADJUTANT_MEMORY_SEARCH_ENABLED: "true",
          ADJUTANT_MEMORY_SEARCH_VECTOR_ENABLED: "true",
        },
      });

      const manager = await MemorySearchManager.create({
        workspaceDir,
        config,
        embeddingProvider: createFakeEmbeddingProvider(),
      });
      const result = await manager.search("routing policy", { maxResults: 3 });

      assert.equal(result.results.length > 0, true);
      assert.equal(
        result.results.some((entry) => entry.path.includes("memory/2026-02-21.md")),
        true
      );

      const read = await manager.readFile({
        relPath: "MEMORY.md",
        from: 1,
        lines: 1,
      });
      assert.equal(read.path, "MEMORY.md");
      assert.equal(read.text.includes("# Decisions"), true);

      await manager.close();
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("埋め込み失敗時でも BM25 で degraded 継続する", async () => {
    const workspaceDir = await mkdtemp(`${tmpdir()}/adjutant-memory-search-`);
    try {
      await mkdir(join(workspaceDir, "memory"), { recursive: true });
      await writeFile(
        join(workspaceDir, "memory", "2026-02-21.md"),
        "policy policy policy\nrouter threshold decision",
        "utf8"
      );
      const config = resolveMemorySearchRuntimeConfig({
        workspaceDir,
        env: {
          ...process.env,
          ADJUTANT_MEMORY_SEARCH_DB_PATH: join(workspaceDir, "memory", "index", "test.sqlite"),
          ADJUTANT_MEMORY_SEARCH_MODEL: "text-embedding-3-small",
          ADJUTANT_MEMORY_SEARCH_ENABLED: "true",
          ADJUTANT_MEMORY_SEARCH_VECTOR_ENABLED: "true",
        },
      });
      const manager = await MemorySearchManager.create({
        workspaceDir,
        config,
        embeddingProvider: createFakeEmbeddingProvider({ failQuery: true }),
      });

      const result = await manager.search("policy", { maxResults: 2 });
      assert.equal(result.results.length > 0, true);
      assert.equal(result.fallback?.from, "openai");
      assert.equal(typeof result.fallback?.reason, "string");
      await manager.close();
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("空クエリは空結果を返す", async () => {
    const workspaceDir = await mkdtemp(`${tmpdir()}/adjutant-memory-search-`);
    try {
      await mkdir(join(workspaceDir, "memory"), { recursive: true });
      await writeFile(join(workspaceDir, "MEMORY.md"), "some memo text", "utf8");

      const config = resolveMemorySearchRuntimeConfig({
        workspaceDir,
        env: {
          ...process.env,
          ADJUTANT_MEMORY_SEARCH_DB_PATH: join(workspaceDir, "memory", "index", "test.sqlite"),
          ADJUTANT_MEMORY_SEARCH_ENABLED: "true",
          ADJUTANT_MEMORY_SEARCH_VECTOR_ENABLED: "true",
        },
      });
      const manager = await MemorySearchManager.create({
        workspaceDir,
        config,
        embeddingProvider: createFakeEmbeddingProvider(),
      });

      const result = await manager.search("   ");
      assert.deepEqual(result.results, []);
      await manager.close();
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("sqlite-vec preflight 失敗は index_unavailable に正規化できる", async () => {
    const workspaceDir = await mkdtemp(`${tmpdir()}/adjutant-memory-search-`);
    try {
      const config = resolveMemorySearchRuntimeConfig({
        workspaceDir,
        env: {
          ...process.env,
          ADJUTANT_MEMORY_SEARCH_DB_PATH: join(workspaceDir, "memory", "index", "test.sqlite"),
          ADJUTANT_MEMORY_SEARCH_ENABLED: "true",
          ADJUTANT_MEMORY_SEARCH_VECTOR_ENABLED: "true",
          ADJUTANT_MEMORY_SEARCH_SQLITE_VEC_PATH: "/tmp/not-found-sqlite-vec.dylib",
        },
      });

      await assert.rejects(
        MemorySearchManager.create({
          workspaceDir,
          config,
          embeddingProvider: createFakeEmbeddingProvider(),
        }),
        /sqlite-vec unavailable/
      );
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("permission_denied はエラー分類へ正規化できる", () => {
    const normalized = normalizeMemorySearchError(new Error("path required"));
    assert.equal(normalized.code, "permission_denied");
  });

  it("ベクター有無でハイブリッド順位が変わる", async () => {
    const workspaceDir = await mkdtemp(`${tmpdir()}/adjutant-memory-search-`);
    try {
      await mkdir(join(workspaceDir, "memory"), { recursive: true });
      await writeFile(
        join(workspaceDir, "memory", "a.md"),
        "foo foo foo foo foo foo foo foo foo foo\ntext for keyword heavy chunk",
        "utf8"
      );
      await writeFile(join(workspaceDir, "memory", "b.md"), "foo vector-aligned chunk", "utf8");

      const config = resolveMemorySearchRuntimeConfig({
        workspaceDir,
        env: {
          ...process.env,
          ADJUTANT_MEMORY_SEARCH_DB_PATH: join(workspaceDir, "memory", "index", "test.sqlite"),
          ADJUTANT_MEMORY_SEARCH_ENABLED: "true",
          ADJUTANT_MEMORY_SEARCH_VECTOR_ENABLED: "true",
          ADJUTANT_MEMORY_SEARCH_VECTOR_WEIGHT: "0.99",
          ADJUTANT_MEMORY_SEARCH_TEXT_WEIGHT: "0.01",
        },
      });

      const withVector = await MemorySearchManager.create({
        workspaceDir,
        config,
        embeddingProvider: createControlledEmbeddingProvider({
          textToVector: (text) => (text.includes("vector-aligned") ? [1, 0, 0] : [0, 1, 0]),
          queryVector: [1, 0, 0],
        }),
      });
      const withVectorResult = await withVector.search("foo", { maxResults: 2 });

      const withoutVector = await MemorySearchManager.create({
        workspaceDir,
        config: {
          ...config,
          dbPath: join(workspaceDir, "memory", "index", "test-no-vector.sqlite"),
        },
        embeddingProvider: createControlledEmbeddingProvider({
          textToVector: (text) => (text.includes("vector-aligned") ? [1, 0, 0] : [0, 1, 0]),
          queryVector: null,
        }),
      });
      const withoutVectorResult = await withoutVector.search("foo", { maxResults: 2 });

      assert.equal(withVectorResult.results.length >= 1, true);
      assert.equal(withoutVectorResult.results.length >= 1, true);
      assert.notEqual(withVectorResult.results[0]?.path, withoutVectorResult.results[0]?.path);

      await withVector.close();
      await withoutVector.close();
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
