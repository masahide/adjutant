export type DynamicActionDescriptor = {
  name: string;
  description: string;
  requiredArgs?: string[];
  argsSchema?: Record<string, unknown>;
};

export type DynamicAction = {
  descriptor: DynamicActionDescriptor;
  validate: (args: Record<string, unknown>) => void;
  execute: (args: Record<string, unknown>) => Promise<unknown> | unknown;
};

export type DynamicProvider = {
  name: string;
  description: string;
  listActions: () => DynamicActionDescriptor[];
  getAction: (actionName: string) => DynamicAction | undefined;
};

export type ProviderCatalogItem = {
  name: string;
  description: string;
};

function normalizeLookupKey(value: string): string {
  return value.trim().toLowerCase();
}

export class ProviderRegistry {
  private readonly providers = new Map<string, DynamicProvider>();

  constructor(initialProviders: DynamicProvider[] = []) {
    for (const provider of initialProviders) {
      this.register(provider);
    }
  }

  register(provider: DynamicProvider): void {
    const normalized = normalizeLookupKey(provider.name);
    if (!normalized) {
      throw new Error("provider.name required");
    }
    this.providers.set(normalized, provider);
  }

  listProviders(): ProviderCatalogItem[] {
    return [...this.providers.values()].map((provider) => ({
      name: provider.name,
      description: provider.description,
    }));
  }

  getProvider(name: string): DynamicProvider | undefined {
    const normalized = normalizeLookupKey(name);
    if (!normalized) {
      return undefined;
    }
    return this.providers.get(normalized);
  }
}
