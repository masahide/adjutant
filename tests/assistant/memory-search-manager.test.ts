import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemorySearchManager,
  normalizeMemorySearchError,
  clearMemorySearchManagerCacheForTest,
  resolveMemorySearchRuntimeConfig,
  type EmbeddingProvider,
} from "../../src/assistant/memory-search/index.js";
import {
  configureAgentAuditLogger,
  flushAgentAuditLoggerForTest,
  resetAgentAuditLoggerForTest,
} from "../../src/assistant/agent-audit.js";

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

function createDelayedEmbeddingProvider(delayMs: number): EmbeddingProvider {
  return {
    provider: "openai",
    model: "text-embedding-3-small",
    embedTexts: async (texts) => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return texts.map((text) => toVector(text));
    },
    embedQuery: async (query) => toVector(query),
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
    resetAgentAuditLoggerForTest();
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

  it("memory_get 読み取り時に file.read 監査イベントを記録する", async () => {
    const workspaceDir = await mkdtemp(`${tmpdir()}/adjutant-memory-search-`);
    try {
      await writeFile(join(workspaceDir, "MEMORY.md"), "audit target", "utf8");
      const auditPath = join(workspaceDir, "audit", "agent-audit.ndjson");
      configureAgentAuditLogger({
        enabled: true,
        path: auditPath,
        maxFieldChars: 4000,
      });

      const config = resolveMemorySearchRuntimeConfig({
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
      await manager.readFile({
        relPath: "MEMORY.md",
        auditScope: { runId: "run-memory-get", sessionKey: "main" },
      });
      await flushAgentAuditLoggerForTest();

      const events = (await readFile(auditPath, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { type: string; path?: string; status?: string });
      assert.equal(
        events.some(
          (event) =>
            event.type === "file.read" && event.path === "MEMORY.md" && event.status === "ok"
        ),
        true
      );

      await manager.close();
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("並行 search でも各 runId に file.read 監査が紐づく", async () => {
    const workspaceDir = await mkdtemp(`${tmpdir()}/adjutant-memory-search-`);
    try {
      await mkdir(join(workspaceDir, "memory"), { recursive: true });
      await writeFile(join(workspaceDir, "MEMORY.md"), "shared memory file", "utf8");
      await writeFile(join(workspaceDir, "memory", "2026-02-23.md"), "policy routing note", "utf8");
      const auditPath = join(workspaceDir, "audit", "agent-audit.ndjson");
      configureAgentAuditLogger({
        enabled: true,
        path: auditPath,
        maxFieldChars: 4000,
      });

      const config = resolveMemorySearchRuntimeConfig({
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
        embeddingProvider: createDelayedEmbeddingProvider(40),
      });

      await Promise.all([
        manager.search("policy", { auditScope: { runId: "run-a", sessionKey: "main" } }),
        manager.search("policy", { auditScope: { runId: "run-b", sessionKey: "main" } }),
      ]);
      await flushAgentAuditLoggerForTest();

      const events = (await readFile(auditPath, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { type: string; runId?: string; path?: string });
      const readEvents = events.filter(
        (event) =>
          event.type === "file.read" &&
          typeof event.path === "string" &&
          event.path.endsWith("MEMORY.md")
      );
      const runIds = new Set(readEvents.map((event) => event.runId));

      assert.equal(runIds.has("run-a"), true);
      assert.equal(runIds.has("run-b"), true);

      await manager.close();
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("search の read エラー時も file.read(status:error) を監査する", async () => {
    const workspaceDir = await mkdtemp(`${tmpdir()}/adjutant-memory-search-`);
    let manager: MemorySearchManager | undefined;
    const blockedPath = join(workspaceDir, "memory", "blocked.md");
    try {
      await mkdir(join(workspaceDir, "memory"), { recursive: true });
      await writeFile(join(workspaceDir, "MEMORY.md"), "readable memory", "utf8");
      await writeFile(blockedPath, "this file is blocked", "utf8");

      const auditPath = join(workspaceDir, "audit", "agent-audit.ndjson");
      configureAgentAuditLogger({
        enabled: true,
        path: auditPath,
        maxFieldChars: 4000,
      });

      const config = resolveMemorySearchRuntimeConfig({
        env: {
          ...process.env,
          ADJUTANT_MEMORY_SEARCH_DB_PATH: join(workspaceDir, "memory", "index", "test.sqlite"),
          ADJUTANT_MEMORY_SEARCH_ENABLED: "true",
          ADJUTANT_MEMORY_SEARCH_VECTOR_ENABLED: "true",
        },
      });
      manager = await MemorySearchManager.create({
        workspaceDir,
        config,
        embeddingProvider: createFakeEmbeddingProvider(),
        readFileUtf8: async (path) => {
          if (path.replaceAll("\\", "/").endsWith("/memory/blocked.md")) {
            throw new Error("forced read failure for test");
          }
          return readFile(path, "utf8");
        },
      });

      await assert.rejects(
        manager.search("blocked", { auditScope: { runId: "run-read-error", sessionKey: "main" } }),
        /forced read failure/
      );
      await flushAgentAuditLoggerForTest();

      const events = (await readFile(auditPath, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as { type: string; runId?: string; path?: string; status?: string }
        );

      assert.equal(
        events.some(
          (event) =>
            event.type === "file.read" &&
            event.runId === "run-read-error" &&
            event.path?.endsWith("blocked.md") &&
            event.status === "error"
        ),
        true
      );
    } finally {
      await manager?.close();
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
