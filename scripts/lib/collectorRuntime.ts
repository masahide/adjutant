export type CollectorRuntimeSettings = {
  enabled: boolean;
  entry: string;
  cdpHost: string;
  cdpPort: number;
  cdpEndpointFile: string;
};

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true") {
    return true;
  }
  if (normalized === "0" || normalized === "false") {
    return false;
  }
  return fallback;
}

function parsePort(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    return fallback;
  }
  return parsed;
}

function setDefault(env: NodeJS.ProcessEnv, key: string, value: string): void {
  if (typeof env[key] !== "string" || env[key]!.trim().length === 0) {
    env[key] = value;
  }
}

export function applyCollectorRuntimeDefaults(
  env: NodeJS.ProcessEnv = process.env
): CollectorRuntimeSettings {
  setDefault(env, "ADJUTANT_COLLECTOR_SLACK_ENABLED", "0");
  setDefault(env, "ADJUTANT_COLLECTOR_SLACK_ENTRY", "src/collector-slack/main.ts");
  setDefault(env, "CDP_ENDPOINT_FILE", ".adjutant/cdp-endpoint.json");
  setDefault(env, "CDP_HOST", "127.0.0.1");
  setDefault(env, "CDP_PORT", "9222");
  setDefault(env, "ADJUTANT_SLACK_ACCOUNT_ID", "default");
  setDefault(env, "ADJUTANT_DISABLE_DOM_CAPTURE", "0");
  setDefault(env, "ADJUTANT_DEBUG_UI", "0");
  setDefault(env, "ADJUTANT_DEBUG_UI_PORT", "8787");

  const cdpHost = env.CDP_HOST?.trim() || "127.0.0.1";
  const cdpPort = parsePort(env.CDP_PORT, 9222);
  env.CDP_PORT = String(cdpPort);

  return {
    enabled: parseBoolean(env.ADJUTANT_COLLECTOR_SLACK_ENABLED, false),
    entry: env.ADJUTANT_COLLECTOR_SLACK_ENTRY?.trim() || "src/collector-slack/main.ts",
    cdpHost,
    cdpPort,
    cdpEndpointFile: env.CDP_ENDPOINT_FILE?.trim() || ".adjutant/cdp-endpoint.json",
  };
}
