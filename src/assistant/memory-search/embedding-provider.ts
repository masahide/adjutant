import OpenAI from "openai";
import type { EmbeddingProvider } from "./types.js";

type OpenAiEmbeddingsClient = {
  embeddings: {
    create: (params: { model: string; input: string | string[] }) => Promise<{
      data: Array<{ embedding?: number[]; index?: number }>;
    }>;
  };
};

export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  readonly provider = "openai";
  readonly model: string;
  private readonly client: OpenAiEmbeddingsClient;

  constructor(params: { model: string; apiKey?: string; client?: OpenAiEmbeddingsClient }) {
    this.model = params.model;
    if (params.client) {
      this.client = params.client;
      return;
    }
    const apiKey = params.apiKey?.trim();
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is required for memory_search");
    }
    this.client = new OpenAI({ apiKey }) as unknown as OpenAiEmbeddingsClient;
  }

  async embedTexts(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }
    const response = await this.client.embeddings.create({
      model: this.model,
      input: texts,
    });
    return response.data
      .slice()
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map((item) => (Array.isArray(item.embedding) ? item.embedding : []));
  }

  async embedQuery(query: string): Promise<number[]> {
    const response = await this.client.embeddings.create({
      model: this.model,
      input: query,
    });
    const first = response.data[0];
    return Array.isArray(first?.embedding) ? first.embedding : [];
  }
}
