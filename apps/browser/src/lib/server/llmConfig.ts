import { readFile } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";

import { resolveConfigDir } from "$lib/server/config";

export type LlmConfig = {
  models: string[];
  defaultModel: string | null;
};

const CONFIG_FILENAME = "reaclog.config.json";
const DEFAULT_MODELS = ["gpt-5-nano", "gpt-5-mini", "gpt-5", "gpt-4.1"];

export async function loadLlmConfig(): Promise<LlmConfig> {
  const candidates = buildConfigCandidates();

  for (const candidate of candidates) {
    const result = await readConfigFile(candidate);
    if (result) {
      return normalizeLlmSection(result);
    }
  }

  return {
    models: [...DEFAULT_MODELS],
    defaultModel: DEFAULT_MODELS[0] ?? null,
  };
}

type RawRuntimeConfig = {
  llm?: {
    models?: unknown;
    defaultModel?: unknown;
    model?: unknown;
  };
};

function buildConfigCandidates(): string[] {
  const configDir = resolveConfigDir();
  return [join(configDir, CONFIG_FILENAME), resolvePath(CONFIG_FILENAME)];
}

async function readConfigFile(path: string): Promise<RawRuntimeConfig | null> {
  try {
    const buffer = await readFile(path, "utf-8");
    const parsed = JSON.parse(buffer) as RawRuntimeConfig;
    return parsed;
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    if (error instanceof SyntaxError) {
      console.warn(`[llmConfig] 無効な JSON を読み飛ばしました (${path}): ${error.message}`);
      return null;
    }
    throw error;
  }
}

function normalizeLlmSection(config: RawRuntimeConfig): LlmConfig {
  const llm = config.llm ?? {};
  let models = extractModels(llm);
  let defaultModel = extractDefaultModel(llm);

  if (models.length === 0) {
    models = [...DEFAULT_MODELS];
  }

  if (defaultModel && !models.includes(defaultModel)) {
    models = [defaultModel, ...models];
  }

  if (!defaultModel) {
    defaultModel = models[0] ?? null;
  }

  return {
    models,
    defaultModel,
  };
}

type RawLlmConfig = NonNullable<RawRuntimeConfig["llm"]>;

function extractModels(llm: RawLlmConfig): string[] {
  const candidates: string[] = [];
  if (Array.isArray(llm.models)) {
    llm.models.forEach((value) => {
      if (typeof value === "string" && value.trim().length > 0) {
        candidates.push(value.trim());
      }
    });
  } else if (typeof llm.model === "string" && llm.model.trim().length > 0) {
    candidates.push(llm.model.trim());
  }
  return dedupe(candidates);
}

function extractDefaultModel(llm: RawLlmConfig): string | null {
  if (typeof llm.defaultModel === "string" && llm.defaultModel.trim().length > 0) {
    return llm.defaultModel.trim();
  }
  if (typeof llm.model === "string" && llm.model.trim().length > 0) {
    return llm.model.trim();
  }
  return null;
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
    }
  }
  return Array.from(seen.values());
}

function isNotFoundError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
  );
}
