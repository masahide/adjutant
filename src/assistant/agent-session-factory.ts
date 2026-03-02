import {
  AuthStorage,
  createBashTool,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent";

import { resolveMemorySearchRuntimeConfig } from "./memory/config.js";
import { createMemoryToolDefinitions } from "./memory/tool-definitions.js";
import type { MemoryScope } from "./memory/types.js";
import { appendDailyMemory, updateLongTermMemory } from "./memory/writer.js";
import { createDockerBashOperations, shouldSandbox } from "../sandbox/docker-bash-operations.js";
import type { ActiveSandboxConfig } from "../sandbox/types.js";

export interface PiAgentSessionLike {
  prompt: (text: string) => Promise<void>;
  subscribe: (listener: (event: unknown) => void) => () => void;
  dispose: () => void;
  abort?: () => Promise<void>;
  getContextUsage?: () => { tokens?: number; contextWindow?: number };
  compact?: () => Promise<unknown>;
  state?: {
    messages?: unknown[];
  };
}

export interface CreatePiAgentSessionOptions {
  cwd: string;
  model?: string;
  memoryScope?: MemoryScope;
  memoryWriteEnabled?: boolean;
  stateDir?: string;
  phaseBRolloutScope?: "main" | "all";
}

let activeSandbox: ActiveSandboxConfig | null = null;

export function configureSandbox(config: ActiveSandboxConfig | null): void {
  activeSandbox = config;
}

function parseModelSpecifier(model: string): { provider: string; modelId: string } | null {
  const spec = model.trim();
  if (spec.length === 0) {
    return null;
  }

  const index = spec.indexOf("/");
  if (index <= 0 || index >= spec.length - 1) {
    return null;
  }

  const provider = spec.slice(0, index).trim();
  const modelId = spec.slice(index + 1).trim();
  if (provider.length === 0 || modelId.length === 0) {
    return null;
  }
  return { provider, modelId };
}

function resolvePhaseBRolloutScope(
  explicit: CreatePiAgentSessionOptions["phaseBRolloutScope"],
  env: NodeJS.ProcessEnv
): "main" | "all" {
  if (explicit === "all" || explicit === "main") {
    return explicit;
  }
  const raw = env.ADJUTANT_PHASE_B_ROLLOUT_SCOPE?.trim().toLowerCase();
  return raw === "all" ? "all" : "main";
}

function isPhaseBEnabledForScope(
  rolloutScope: "main" | "all",
  memoryScope: MemoryScope | undefined
): boolean {
  if (rolloutScope === "all") {
    return true;
  }
  return memoryScope === "main";
}

export async function createPiAgentSession(
  options: CreatePiAgentSessionOptions
): Promise<{ session: PiAgentSessionLike }> {
  const authStorage = new AuthStorage();
  const modelRegistry = new ModelRegistry(authStorage);
  const settingsManager = SettingsManager.inMemory();

  const modelSpec = options.model?.trim();
  const parsed = modelSpec ? parseModelSpecifier(modelSpec) : null;
  const model = parsed ? modelRegistry.find(parsed.provider, parsed.modelId) : undefined;
  const customTools = buildCustomToolDefinitions(options);

  const created = await createAgentSession({
    cwd: options.cwd,
    sessionManager: SessionManager.inMemory(options.cwd),
    authStorage,
    modelRegistry,
    settingsManager,
    model,
    customTools,
  });

  return {
    session: created.session as PiAgentSessionLike,
  };
}

export function buildCustomToolDefinitions(options: CreatePiAgentSessionOptions): ToolDefinition[] {
  const customTools: ToolDefinition[] = [];
  const rolloutScope = resolvePhaseBRolloutScope(options.phaseBRolloutScope, process.env);
  const phaseBEnabled = isPhaseBEnabledForScope(rolloutScope, options.memoryScope);

  if (options.memoryScope === "main") {
    customTools.push(
      ...createMemoryToolDefinitions({
        workspaceDir: options.cwd,
        config: resolveMemorySearchRuntimeConfig({
          stateDir: options.stateDir,
          agentId: "main",
        }),
      })
    );
  }
  if (options.memoryWriteEnabled && phaseBEnabled) {
    customTools.push(createMemoryWriteToolDefinition(options.cwd));
  }
  const sandboxConfig = activeSandbox;
  if (
    sandboxConfig !== null &&
    shouldSandbox(sandboxConfig.mode, options.memoryScope) &&
    options.memoryScope !== undefined
  ) {
    const sandboxBashTool = createBashTool(options.cwd, {
      operations: createDockerBashOperations({
        runSpec: sandboxConfig.runSpec,
      }),
    });
    customTools.push(sandboxBashTool as unknown as ToolDefinition);
  }

  return customTools;
}

function createMemoryWriteToolDefinition(workspaceDir: string): ToolDefinition {
  return {
    name: "memory_write",
    label: "Memory Write",
    description: "Persist notable context into assistant memory files.",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", minLength: 1 },
        scope: { enum: ["daily", "long-term"] },
      },
      required: ["content"],
      additionalProperties: false,
    } as never,
    execute: async (_toolCallId, rawParams) => {
      const params = (rawParams ?? {}) as Record<string, unknown>;
      const content = typeof params.content === "string" ? params.content.trim() : "";
      if (content.length === 0) {
        throw new Error("content required");
      }

      const scope = params.scope === "long-term" ? "long-term" : "daily";
      const written =
        scope === "long-term"
          ? await updateLongTermMemory({ workspaceDir, content })
          : await appendDailyMemory({ workspaceDir, content });
      return {
        content: [{ type: "text", text: `memory_write accepted (${scope})` }],
        details: {
          scope,
          path: written.path,
        },
      };
    },
  };
}
