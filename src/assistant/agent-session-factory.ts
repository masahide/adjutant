import {
  AuthStorage,
  createBashTool,
  type ContextUsage,
  createAgentSession,
  ModelRegistry,
  readOnlyTools,
  SettingsManager,
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import type { AgentAuditScope } from "./agent-audit.js";
import { createMemoryToolDefinitions } from "./memory-search/index.js";
import { createDockerBashOperations, shouldSandbox } from "../sandbox/docker-bash-operations.js";
import type { SandboxMode } from "../sandbox/types.js";
import {
  REPORT_HEARTBEAT_STATUS_TOOL,
  validateReportHeartbeatStatusInput,
} from "../proactive/routing-tools.js";

export type AgentSessionLike = {
  subscribe: (listener: (event: unknown) => void) => () => void;
  prompt: (text: string) => Promise<void>;
  sendCustomMessage?: <T = unknown>(
    message: {
      customType: string;
      content: string | Array<{ type: string; text?: string }>;
      display: boolean;
      details?: T;
    },
    options?: {
      triggerTurn?: boolean;
      deliverAs?: "steer" | "followUp" | "nextTurn";
    }
  ) => Promise<void>;
  getContextUsage?: () => ContextUsage | undefined;
  compact?: (customInstructions?: string) => Promise<unknown>;
  dispose: () => void;
  sessionId?: string;
  sessionFile?: string;
  model?: unknown;
};

export type CreateAgentSessionParams = {
  sessionManager: unknown;
  runId: string;
  sessionKey: string;
  model?: string;
  isHeartbeat?: boolean;
  memoryWriteEnabled?: boolean;
  memoryScope?: "main" | "spoke";
  workspaceDir: string;
  onWarn?: (message: string, meta?: Record<string, unknown>) => void;
};

type ActiveSandboxConfig = {
  containerName: string;
  workdir: string;
  hostWorkspaceDir: string;
  mode: SandboxMode;
};

let activeSandbox: ActiveSandboxConfig | null = null;

export function configureSandbox(config: ActiveSandboxConfig | null): void {
  activeSandbox = config;
}

function parseModelSpecifier(model: string): { provider: string; modelId: string } | null {
  const specifier = model.trim();
  if (!specifier) {
    return null;
  }
  const firstSlash = specifier.indexOf("/");
  if (firstSlash <= 0 || firstSlash === specifier.length - 1) {
    return null;
  }
  const provider = specifier.slice(0, firstSlash).trim();
  const modelId = specifier.slice(firstSlash + 1).trim();
  if (!provider || !modelId) {
    return null;
  }
  return { provider, modelId };
}

function resolveModelSelection(
  modelRegistry: ModelRegistry,
  model: string | undefined
): { matched: boolean; model?: unknown; provider?: string; modelId?: string } {
  const specifier = model?.trim();
  if (!specifier) {
    return { matched: false };
  }

  const explicit = parseModelSpecifier(specifier);
  if (explicit) {
    const found = modelRegistry.find(explicit.provider, explicit.modelId);
    if (found) {
      return {
        matched: true,
        model: found,
        provider: found.provider,
        modelId: found.id,
      };
    }
    return {
      matched: false,
      provider: explicit.provider,
      modelId: explicit.modelId,
    };
  }

  const byId = modelRegistry
    .getAll()
    .filter((candidate) => candidate.id.toLowerCase() === specifier.toLowerCase());
  if (byId.length === 0) {
    return {
      matched: false,
      modelId: specifier,
    };
  }
  const selected = byId[0];
  return {
    matched: true,
    model: selected,
    provider: selected.provider,
    modelId: selected.id,
  };
}

function createMemoryWriteToolDefinition(): ToolDefinition {
  return {
    name: "memory_write",
    label: "Memory Write",
    description: "Persist notable user preference or context into assistant memory.",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", minLength: 1 },
        scope: { enum: ["daily", "long-term"] },
      },
      required: ["content"],
      additionalProperties: false,
    } as never,
    execute: async (_toolCallId, params) => {
      const record = params as { scope?: unknown; content?: unknown };
      const scope = record.scope === "long-term" ? "long-term" : "daily";
      const content = typeof record.content === "string" ? record.content : "";
      return {
        content: [{ type: "text", text: `memory_write accepted (${scope})` }],
        details: { scope, content },
      };
    },
  };
}

function createReportHeartbeatStatusToolDefinition(): ToolDefinition {
  return {
    name: REPORT_HEARTBEAT_STATUS_TOOL.name,
    label: "Heartbeat Status",
    description: REPORT_HEARTBEAT_STATUS_TOOL.description,
    parameters: {
      type: "object",
      properties: {
        status: {
          enum: ["no_action_needed", "needs_attention", "task_completed"],
        },
        notify: { type: "boolean" },
        reason: { type: "string", minLength: 1 },
      },
      required: ["status", "notify", "reason"],
      additionalProperties: false,
    } as never,
    execute: async (_toolCallId, params) => {
      const accepted = validateReportHeartbeatStatusInput(params);
      return {
        content: [{ type: "text", text: "heartbeat status accepted" }],
        details: accepted,
      };
    },
  };
}

export async function createAgentSessionFromSdk(
  params: CreateAgentSessionParams
): Promise<{ session: AgentSessionLike }> {
  const authStorage = new AuthStorage();
  const modelRegistry = new ModelRegistry(authStorage);
  const resolvedModel = resolveModelSelection(modelRegistry, params.model);
  const settingsOverrides: { defaultProvider?: string; defaultModel?: string } = {};
  if (resolvedModel.provider) {
    settingsOverrides.defaultProvider = resolvedModel.provider;
  }
  if (resolvedModel.modelId) {
    settingsOverrides.defaultModel = resolvedModel.modelId;
  }
  const settingsManager = SettingsManager.inMemory(settingsOverrides);
  const customTools: ToolDefinition[] = [];
  if (params.isHeartbeat) {
    customTools.push(createReportHeartbeatStatusToolDefinition());
  }
  if (params.memoryScope === "main") {
    customTools.push(
      ...createMemoryToolDefinitions({
        workspaceDir: params.workspaceDir,
        auditScope: {
          runId: params.runId,
          sessionKey: params.sessionKey,
        } satisfies AgentAuditScope,
        onWarn: (message, meta) => {
          params.onWarn?.(message, meta);
        },
      })
    );
  }
  if (params.memoryWriteEnabled) {
    customTools.push(createMemoryWriteToolDefinition());
  }
  const currentSandbox = activeSandbox;
  if (
    currentSandbox &&
    !params.isHeartbeat &&
    shouldSandbox(currentSandbox.mode, params.memoryScope)
  ) {
    // NOTE:
    // createAgentSession(options.tools) currently keeps only active tool names and rebuilds
    // base tools internally, so custom bash operations passed via createCodingTools are lost.
    // Registering a custom tool named "bash" overrides the base bash tool at runtime.
    const sandboxedBash = createBashTool(params.workspaceDir, {
      operations: createDockerBashOperations({
        containerName: currentSandbox.containerName,
        hostWorkspaceDir: currentSandbox.hostWorkspaceDir,
        containerWorkdir: currentSandbox.workdir,
      }),
    });
    customTools.push(sandboxedBash as unknown as ToolDefinition);
  }

  const created = await createAgentSession({
    cwd: params.workspaceDir,
    sessionManager: params.sessionManager as never,
    settingsManager,
    modelRegistry,
    model: resolvedModel.model as never,
    tools: params.isHeartbeat ? readOnlyTools : undefined,
    customTools,
  });

  return {
    session: created.session as AgentSessionLike,
  };
}

export function isAgentModelAvailable(model?: string): boolean {
  const specifier = model?.trim();
  if (!specifier) {
    return true;
  }
  const modelRegistry = new ModelRegistry(new AuthStorage());
  return resolveModelSelection(modelRegistry, specifier).matched;
}
