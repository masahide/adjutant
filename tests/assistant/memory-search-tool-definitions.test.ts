import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryToolDefinitions } from "../../src/assistant/memory-search/index.js";
import type { EmbeddingProvider } from "../../src/assistant/memory-search/index.js";

function createFakeEmbeddingProvider(): EmbeddingProvider {
  return {
    provider: "openai",
    model: "text-embedding-3-small",
    embedTexts: async (texts) => texts.map(() => [0.1, 0.2, 0.3]),
    embedQuery: async () => [0.1, 0.2, 0.3],
  };
}

describe("memory-search tool definitions", () => {
  it("memory_get の拒否ログに本文を含めない", async () => {
    const workspaceDir = await mkdtemp(`${tmpdir()}/adjutant-memory-tool-`);
    try {
      await mkdir(join(workspaceDir, "memory"), { recursive: true });
      await writeFile(join(workspaceDir, "MEMORY.md"), "sensitive-content", "utf8");

      const warns: Array<{ message: string; meta?: Record<string, unknown> }> = [];
      const tools = createMemoryToolDefinitions({
        workspaceDir,
        embeddingProvider: createFakeEmbeddingProvider(),
        onWarn: (message, meta) => warns.push({ message, meta }),
      });
      const memoryGet = tools.find((tool) => tool.name === "memory_get");
      assert.ok(memoryGet);

      const result = await memoryGet!.execute(
        "call-1",
        {
          path: "../../secret.txt",
        } as never,
        new AbortController().signal,
        async () => undefined,
        {} as never
      );
      const payload = result.details as { disabled?: boolean; error?: string };
      assert.equal(payload.disabled, true);
      assert.equal(payload.error, "path required");

      assert.equal(warns.length, 1);
      const serializedMeta = JSON.stringify(warns[0]?.meta ?? {});
      assert.equal(serializedMeta.includes("sensitive-content"), false);
      assert.equal(serializedMeta.includes("../../secret.txt"), true);
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("memory_search 失敗ログに query 本文を含めない", async () => {
    const workspaceDir = await mkdtemp(`${tmpdir()}/adjutant-memory-tool-`);
    try {
      const warns: Array<{ message: string; meta?: Record<string, unknown> }> = [];
      const tools = createMemoryToolDefinitions({
        workspaceDir,
        embeddingProvider: createFakeEmbeddingProvider(),
        config: {
          enabled: true,
          model: "text-embedding-3-small",
          maxResults: 5,
          minScore: 0,
          vectorEnabled: false,
          sqliteVecPath: "",
          dbPath: join(workspaceDir, "memory", "index", "main.sqlite"),
          chunkChars: 1600,
          chunkOverlapChars: 320,
          snippetMaxChars: 700,
          candidateMultiplier: 3,
          vectorWeight: 0.7,
          textWeight: 0.3,
        },
        onWarn: (message, meta) => warns.push({ message, meta }),
      });
      const memorySearch = tools.find((tool) => tool.name === "memory_search");
      assert.ok(memorySearch);

      const queryText = "secret-query-text";
      const result = await memorySearch!.execute(
        "call-2",
        {
          query: queryText,
        } as never,
        new AbortController().signal,
        async () => undefined,
        {} as never
      );
      const payload = result.details as { disabled?: boolean; error?: string };
      assert.equal(payload.disabled, true);
      assert.equal(typeof payload.error, "string");

      assert.equal(warns.length, 1);
      const serializedMeta = JSON.stringify(warns[0]?.meta ?? {});
      assert.equal(serializedMeta.includes(queryText), false);
      assert.equal(serializedMeta.includes("index_unavailable"), true);
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
