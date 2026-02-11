import { writable } from "svelte/store";

type LlmConfig = {
  models: string[];
  defaultModel: string | null;
};

const modelsStore = writable<string[]>([]);
const defaultModelStore = writable<string | null>(null);

export const llmModelsStore = {
  subscribe: modelsStore.subscribe,
};

export const llmDefaultModelStore = {
  subscribe: defaultModelStore.subscribe,
};

export function initializeLlmStore(config: LlmConfig) {
  modelsStore.set(config.models);
  defaultModelStore.set(config.defaultModel);
}
