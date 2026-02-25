import {
  buildBootstrapContextFiles,
  renderProjectContext,
  type EmbeddedContextFile,
} from "./bootstrap-context.js";
import type { WorkspaceBootstrapFile } from "./workspace-bootstrap.js";
import type { ResolvedAgentRunContext } from "./agent-run-context.js";
import type { AgentRunOptions } from "./agent-runner.js";
import { normalizeSessionKey, normalizeTimezone } from "./shared-normalizers.js";
import { resolveSessionEntriesPath } from "./session-entry-store.js";

export type BuildAgentPromptParams = {
  basePrompt: string;
  systemPrompt?: string;
  memory: { longTerm: string | null; daily: string | null };
  bootstrapFiles?: WorkspaceBootstrapFile[];
  onBootstrapWarn?: (message: string, meta?: Record<string, unknown>) => void;
};

export function shouldEnableMemoryWrite(opts: AgentRunOptions): boolean {
  if (opts.isHeartbeat) {
    return false;
  }
  if (typeof opts.memoryWriteRequested === "boolean") {
    return opts.memoryWriteRequested;
  }
  return /覚えておいて|覚えといて|remember\s+(this|that)|remember\b/i.test(opts.prompt);
}

export function resolveMemoryScope(
  requestedScope: AgentRunOptions["memoryScope"],
  sessionKey: string
): "main" | "spoke" {
  if (requestedScope === "main" || requestedScope === "spoke") {
    return requestedScope;
  }
  return sessionKey === "main" ? "main" : "spoke";
}

export function shouldInjectBootstrapContext(context: ResolvedAgentRunContext): boolean {
  if (context.origin !== "user") {
    return false;
  }
  if (context.isHeartbeat) {
    return false;
  }
  if (context.sessionKey !== "main") {
    return false;
  }
  return context.memoryScope === "main";
}

export function resolveAgentRunContext(opts: AgentRunOptions): ResolvedAgentRunContext {
  const sessionKey = normalizeSessionKey(opts.sessionKey);
  const workspaceDir = opts.workspaceDir?.trim() || process.cwd();
  const timezone = normalizeTimezone(opts.timezone);
  const sessionEntriesPath = resolveSessionEntriesPath(opts.sessionEntriesPath);
  const memoryWriteEnabled = shouldEnableMemoryWrite(opts);
  const memoryScope = resolveMemoryScope(opts.memoryScope, sessionKey);

  return {
    runId: opts.runId,
    prompt: opts.prompt,
    systemPrompt: opts.systemPrompt,
    sessionKey,
    sessionId: opts.sessionId,
    model: opts.model,
    origin: opts.origin ?? "system",
    memoryScope,
    isHeartbeat: Boolean(opts.isHeartbeat),
    heartbeatMeta: opts.heartbeatMeta,
    memoryWriteEnabled,
    workspaceDir,
    timezone,
    sessionEntriesPath,
  };
}

function withSystemPrompt(prompt: string, systemPrompt: string | undefined): string {
  const cleanedPrompt = prompt.trim();
  const cleanedSystemPrompt = typeof systemPrompt === "string" ? systemPrompt.trim() : "";
  if (!cleanedSystemPrompt) {
    return cleanedPrompt;
  }
  if (!cleanedPrompt) {
    return cleanedSystemPrompt;
  }
  return `${cleanedSystemPrompt}\n\n${cleanedPrompt}`;
}

function appendMemoryContext(
  prompt: string,
  memory: { longTerm: string | null; daily: string | null }
): string {
  const sections: string[] = [];
  const longTerm = memory.longTerm?.trim();
  if (longTerm) {
    sections.push(`## Memory\n${longTerm}`);
  }
  const daily = memory.daily?.trim();
  if (daily) {
    sections.push(`## Daily Memory\n${daily}`);
  }
  if (sections.length === 0) {
    return prompt;
  }
  return `${sections.join("\n\n")}\n\n${prompt}`;
}

function appendProjectContext(prompt: string, contextFiles: EmbeddedContextFile[]): string {
  const projectContext = renderProjectContext(contextFiles).trim();
  if (!projectContext) {
    return prompt;
  }
  return `${projectContext}\n\n${prompt}`;
}

export function buildAgentPrompt(params: BuildAgentPromptParams): string {
  let prompt = withSystemPrompt(params.basePrompt, params.systemPrompt);
  prompt = appendMemoryContext(prompt, params.memory);

  if (!params.bootstrapFiles) {
    return prompt;
  }

  const contextFiles = buildBootstrapContextFiles(params.bootstrapFiles, {
    onWarn: (message, meta) => {
      params.onBootstrapWarn?.(message, meta);
    },
  });
  return appendProjectContext(prompt, contextFiles);
}
