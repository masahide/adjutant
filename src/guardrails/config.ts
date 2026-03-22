import { homedir } from "node:os";
import { resolve } from "node:path";

import { resolveWorkspaceDir } from "../runtime/runtime-directories.js";
import type {
  GuardrailMode,
  GuardrailPermissionSelection,
  GuardrailPermissionOutcome,
} from "./types.js";

const DEFAULT_PERMISSION_TIMEOUT_MS = 30_000;
const DEFAULT_RPC_TIMEOUT_MS = 5_000;
const DEFAULT_LLM_MODEL = "gpt-5-mini";
const DEFAULT_LLM_TIMEOUT_MS = 3_000;

export interface GuardrailRuntimeConfig {
  mode: GuardrailMode;
  stateDir: string;
  permissionTimeoutMs: number;
  permissionTimeoutSelection: GuardrailPermissionSelection;
  rpcTimeoutMs: number;
  rpcTimeoutOutcome: Exclude<GuardrailPermissionOutcome, "allow">;
  llm: {
    enabled: boolean;
    apiKey?: string;
    model: string;
    timeoutMs: number;
  };
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(1, Math.floor(parsed));
}

export function resolveGuardrailMode(
  explicit: GuardrailMode | undefined,
  env: NodeJS.ProcessEnv
): GuardrailMode {
  if (explicit === "off" || explicit === "audit" || explicit === "enforce") {
    return explicit;
  }

  const normalized = env.ADJUTANT_GUARDRAIL_MODE?.trim().toLowerCase();
  if (normalized === "audit") {
    return "audit";
  }
  if (normalized === "enforce") {
    return "enforce";
  }
  return "off";
}

function resolveStateDir(env: NodeJS.ProcessEnv, explicit?: string): string {
  const raw = explicit?.trim() || env.ADJUTANT_STATE_DIR?.trim();
  if (raw && raw.length > 0) {
    return resolve(raw);
  }
  return resolve(homedir(), ".adjutant");
}

export function resolveGuardrailWorkspaceScopeKey(input: {
  env?: NodeJS.ProcessEnv;
  projectRoot?: string;
  workspaceDir?: string;
  stateDir?: string;
}): string {
  const env = input.env ?? process.env;
  const projectRoot = resolve(input.projectRoot ?? process.cwd());
  const workspaceDir = resolve(
    input.workspaceDir ?? resolveWorkspaceDir({ env, stateDir: input.stateDir })
  );
  return `projectRoot:${projectRoot}::workspaceDir:${workspaceDir}`;
}

function resolvePermissionTimeoutSelection(
  value: string | undefined
): GuardrailPermissionSelection {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "cancelled") {
    return "cancelled";
  }
  return "reject_once";
}

function resolveRpcTimeoutOutcome(
  value: string | undefined
): Exclude<GuardrailPermissionOutcome, "allow"> {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "cancelled") {
    return "cancelled";
  }
  return "deny";
}

export function resolveGuardrailRuntimeConfig(input: {
  env?: NodeJS.ProcessEnv;
  mode?: GuardrailMode;
  stateDir?: string;
}): GuardrailRuntimeConfig {
  const env = input.env ?? process.env;
  return {
    mode: resolveGuardrailMode(input.mode, env),
    stateDir: resolveStateDir(env, input.stateDir),
    permissionTimeoutMs: parsePositiveInt(
      env.ADJUTANT_GUARDRAIL_PERMISSION_TIMEOUT_MS,
      DEFAULT_PERMISSION_TIMEOUT_MS
    ),
    permissionTimeoutSelection: resolvePermissionTimeoutSelection(
      env.ADJUTANT_GUARDRAIL_TIMEOUT_OUTCOME
    ),
    rpcTimeoutMs: parsePositiveInt(env.ADJUTANT_GUARDRAIL_RPC_TIMEOUT_MS, DEFAULT_RPC_TIMEOUT_MS),
    rpcTimeoutOutcome: resolveRpcTimeoutOutcome(env.ADJUTANT_GUARDRAIL_RPC_TIMEOUT_OUTCOME),
    llm: {
      enabled:
        env.ADJUTANT_GUARDRAIL_LLM_ENABLED?.trim() === "1" ||
        env.ADJUTANT_GUARDRAIL_LLM_ENABLED?.trim()?.toLowerCase() === "true",
      apiKey: env.OPENAI_API_KEY?.trim() || undefined,
      model: env.ADJUTANT_GUARDRAIL_LLM_MODEL?.trim() || DEFAULT_LLM_MODEL,
      timeoutMs: parsePositiveInt(env.ADJUTANT_GUARDRAIL_LLM_TIMEOUT_MS, DEFAULT_LLM_TIMEOUT_MS),
    },
  };
}
