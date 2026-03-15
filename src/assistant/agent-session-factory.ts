import {
  AuthStorage,
  createBashTool,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent";

import type { MemoryScope } from "./memory/types.js";
import { createDockerBashOperations, shouldSandbox } from "../sandbox/docker-bash-operations.js";
import type { ActiveSandboxConfig } from "../sandbox/types.js";
import { createContainerizedFileTools } from "./containerized-file-tool-operations.js";
import { createToolHubToolDefinition, ToolHub } from "./dynamic-tool/index.js";
import { createAssistantProviderRegistry } from "./tool-hub-provider-registry.js";

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
  projectRoot?: string;
  model?: string;
  memoryScope?: MemoryScope;
  memoryWriteEnabled?: boolean;
  stateDir?: string;
  phaseBRolloutScope?: "main" | "all";
  isHeartbeat?: boolean;
}

let activeSandbox: ActiveSandboxConfig | null = null;

export function configureSandbox(config: ActiveSandboxConfig | null): void {
  activeSandbox = config;
}

export function getConfiguredSandbox(): ActiveSandboxConfig | null {
  return activeSandbox;
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
  if (options.isHeartbeat === true) {
    return customTools;
  }
  const rolloutScope = resolvePhaseBRolloutScope(options.phaseBRolloutScope, process.env);
  const phaseBEnabled = isPhaseBEnabledForScope(rolloutScope, options.memoryScope);

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
    customTools.push(...createContainerizedFileTools({ runSpec: sandboxConfig.runSpec }));
  }
  const providerRegistry = createAssistantProviderRegistry({
    workspaceDir: options.cwd,
    projectRoot: options.projectRoot,
    stateDir: options.stateDir,
    includeMemoryRead: options.memoryScope === "main",
    includeMemoryWrite: options.memoryWriteEnabled === true && phaseBEnabled,
  });
  customTools.push(createToolHubToolDefinition(new ToolHub(providerRegistry)));

  return customTools;
}
