import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  POLICY_ROUTING_SCHEMA_V1,
  type PolicyRoutingChannelRule,
  type PolicyRoutingV1,
} from "./types.js";

const DEFAULT_POLICY_ROUTING_PATH = join(process.cwd(), "memory", "POLICY_ROUTING.json");

export type PolicyRoutingLoaderOptions = {
  path?: string;
  onWarn?: (message: string, meta?: Record<string, unknown>) => void;
};

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  if (value < 0) {
    return undefined;
  }
  return value;
}

function asHourMinute(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  if (!normalized) {
    return undefined;
  }
  if (!/^\d{2}:\d{2}$/.test(normalized)) {
    return undefined;
  }
  const [hoursRaw, minutesRaw] = normalized.split(":");
  const hours = Number(hoursRaw);
  const minutes = Number(minutesRaw);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) {
    return undefined;
  }
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return undefined;
  }
  return normalized;
}

function asPriority(value: unknown): PolicyRoutingChannelRule["priority"] {
  if (value === "high" || value === "normal" || value === "low") {
    return value;
  }
  return undefined;
}

function normalizeChannelRule(input: unknown): PolicyRoutingChannelRule | null {
  const source = asObject(input);
  if (!source) {
    return null;
  }
  const rule: PolicyRoutingChannelRule = {
    priority: asPriority(source.priority),
    quietHoursStart: asHourMinute(source.quietHoursStart),
    quietHoursEnd: asHourMinute(source.quietHoursEnd),
    notifyBudgetPerHour: asNonNegativeNumber(source.notifyBudgetPerHour),
    cooldownMs: asNonNegativeNumber(source.cooldownMs),
  };
  return rule;
}

function createDefaultPolicy(): PolicyRoutingV1 {
  return {
    schema: POLICY_ROUTING_SCHEMA_V1,
    channels: {},
    defaults: {},
  };
}

function normalizePolicyRouting(input: unknown): PolicyRoutingV1 {
  const source = asObject(input);
  if (!source) {
    return createDefaultPolicy();
  }

  const channelsSource = asObject(source.channels) ?? {};
  const channels: NonNullable<PolicyRoutingV1["channels"]> = {};
  for (const [channelId, rawRule] of Object.entries(channelsSource)) {
    const key = channelId.trim();
    if (!key) {
      continue;
    }
    const rule = normalizeChannelRule(rawRule);
    if (!rule) {
      continue;
    }
    channels[key] = rule;
  }

  const defaultsSource = asObject(source.defaults);
  const defaults = defaultsSource
    ? {
        notifyBudgetPerHour: asNonNegativeNumber(defaultsSource.notifyBudgetPerHour),
        cooldownMs: asNonNegativeNumber(defaultsSource.cooldownMs),
      }
    : {};

  return {
    schema: POLICY_ROUTING_SCHEMA_V1,
    channels,
    defaults,
  };
}

export function resolvePolicyRoutingPath(customPath?: string): string {
  const preferred = customPath?.trim();
  if (preferred) {
    return preferred;
  }
  const fromEnv = process.env.ADJUTANT_POLICY_ROUTING_PATH?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  return DEFAULT_POLICY_ROUTING_PATH;
}

export async function loadPolicyRouting(
  options: PolicyRoutingLoaderOptions = {}
): Promise<PolicyRoutingV1> {
  const path = resolvePolicyRoutingPath(options.path);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") {
      return createDefaultPolicy();
    }
    throw error;
  }

  try {
    const parsed = JSON.parse(raw);
    return normalizePolicyRouting(parsed);
  } catch (error) {
    options.onWarn?.("policy-routing-parse-failed", {
      path,
      error: error instanceof Error ? error.message : String(error),
    });
    return createDefaultPolicy();
  }
}

export function resolveRoutingRule(
  policy: PolicyRoutingV1,
  channelId: string
): PolicyRoutingChannelRule {
  const channelKey = channelId.trim();
  const defaults = policy.defaults ?? {};
  const channelRule = (policy.channels ?? {})[channelKey] ?? {};
  return {
    priority: channelRule.priority,
    quietHoursStart: channelRule.quietHoursStart,
    quietHoursEnd: channelRule.quietHoursEnd,
    notifyBudgetPerHour: channelRule.notifyBudgetPerHour ?? defaults.notifyBudgetPerHour,
    cooldownMs: channelRule.cooldownMs ?? defaults.cooldownMs,
  };
}
