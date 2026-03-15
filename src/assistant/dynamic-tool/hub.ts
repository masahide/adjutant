import { createToolHubError, createToolHubSuccess } from "./response.js";
import type { DynamicAction, ProviderRegistry } from "./registry.js";
import type { ToolHubInput, ToolHubResult } from "./types.js";

type ParsedToolHubInput = {
  input: ToolHubInput;
  hasArgs: boolean;
};

function readNonEmptyString(value: unknown, key: "provider" | "action"): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${key} must be string`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed;
}

function parseInput(raw: unknown): ParsedToolHubInput {
  if (raw === undefined || raw === null) {
    return { input: {}, hasArgs: false };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("input must be object");
  }

  const record = raw as Record<string, unknown>;
  const provider = readNonEmptyString(record.provider, "provider");
  const action = readNonEmptyString(record.action, "action");
  const hasArgs = Object.prototype.hasOwnProperty.call(record, "args");
  const rawArgs = record.args;
  if (hasArgs && (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs))) {
    throw new Error("args must be object");
  }

  return {
    input: {
      provider,
      action,
      args: hasArgs ? (rawArgs as Record<string, unknown>) : undefined,
    },
    hasArgs,
  };
}

function actionHelpData(action: DynamicAction): Record<string, unknown> {
  return {
    name: action.descriptor.name,
    description: action.descriptor.description,
    requiredArgs: action.descriptor.requiredArgs ?? [],
    argsSchema: action.descriptor.argsSchema ?? { type: "object" },
  };
}

export class ToolHub {
  constructor(private readonly providerRegistry: ProviderRegistry) {}

  async execute(rawInput?: unknown): Promise<ToolHubResult> {
    let parsed: ParsedToolHubInput;
    try {
      parsed = parseInput(rawInput);
    } catch (error) {
      return createToolHubError({
        code: "validation_error",
        message: error instanceof Error ? error.message : "invalid input",
      });
    }

    const providerName = parsed.input.provider;
    if (!providerName) {
      return createToolHubSuccess({
        mode: "catalog",
        data: {
          providers: this.providerRegistry.listProviders(),
          usage: "set provider to get actions",
        },
      });
    }

    const provider = this.providerRegistry.getProvider(providerName);
    if (!provider) {
      return createToolHubError({
        code: "unknown_provider",
        provider: providerName,
        message: `unknown provider: ${providerName}`,
      });
    }

    const actionName = parsed.input.action;
    if (!actionName) {
      return createToolHubSuccess({
        mode: "provider_help",
        provider: provider.name,
        data: {
          actions: provider.listActions(),
        },
      });
    }

    const action = provider.getAction(actionName);
    if (!action) {
      return createToolHubError({
        code: "unknown_action",
        provider: provider.name,
        action: actionName,
        message: `unknown action: ${actionName}`,
      });
    }

    if (!parsed.hasArgs) {
      return createToolHubSuccess({
        mode: "action_help",
        provider: provider.name,
        action: action.descriptor.name,
        data: actionHelpData(action),
      });
    }

    const args = parsed.input.args ?? {};
    try {
      action.validate(args);
    } catch (error) {
      return createToolHubError({
        code: "validation_error",
        provider: provider.name,
        action: action.descriptor.name,
        message: error instanceof Error ? error.message : "validation failed",
      });
    }

    try {
      const data = await action.execute(args);
      return createToolHubSuccess({
        mode: "execute",
        provider: provider.name,
        action: action.descriptor.name,
        data,
      });
    } catch (error) {
      return createToolHubError({
        code: "execution_error",
        provider: provider.name,
        action: action.descriptor.name,
        message: error instanceof Error ? error.message : "execution failed",
      });
    }
  }
}
