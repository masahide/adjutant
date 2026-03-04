export const DEFAULT_DELIVER_ENTRY = "src/deliver-slack/stdio-server.ts";

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "1" || normalized === "true") {
    return true;
  }
  if (normalized === "0" || normalized === "false") {
    return false;
  }
  return fallback;
}

export type DeliverSlackConfig = {
  deliverEnabled: boolean;
  deliverEntry: string;
};

export function loadDeliverSlackConfig(
  options: {
    env?: NodeJS.ProcessEnv;
  } = {}
): DeliverSlackConfig {
  const env = options.env ?? process.env;
  return {
    deliverEnabled: parseBoolean(env.ADJUTANT_DELIVER_SLACK_ENABLED, false),
    deliverEntry: env.ADJUTANT_DELIVER_SLACK_ENTRY?.trim() || DEFAULT_DELIVER_ENTRY,
  };
}
