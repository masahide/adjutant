export function createSlackDebugTargets(raw = process.env.ADJUTANT_DEBUG ?? ""): Set<string> {
  return new Set(
    raw
      .split(",")
      .map((token) => token.trim())
      .filter((token) => token.length > 0)
  );
}

export function hasSlackDebugTarget(targets: ReadonlySet<string>, ...names: string[]): boolean {
  return names.some((name) => targets.has(name));
}

export type SlackDebugOptions = {
  prefix: string;
  enabled: boolean;
  verboseEnabled?: boolean;
  logger?: (...args: unknown[]) => void;
};

export class SlackDebug {
  private readonly prefix: string;
  private readonly enabled: boolean;
  private readonly verboseEnabled: boolean;
  private readonly logger: (...args: unknown[]) => void;

  constructor(options: SlackDebugOptions) {
    this.prefix = options.prefix;
    this.enabled = options.enabled;
    this.verboseEnabled = options.verboseEnabled ?? false;
    this.logger = options.logger ?? console.log;
  }

  debug(message: string, payload?: unknown): void {
    if (!this.enabled) return;
    if (payload === undefined) {
      this.logger(`[${this.prefix}] ${message}`);
      return;
    }
    this.logger(`[${this.prefix}] ${message}:`, payload);
  }

  verbose(message: string, payload?: unknown): void {
    if (!this.verboseEnabled) return;
    this.debug(message, payload);
  }

  safePreview(payload: unknown): unknown {
    if (!payload) return payload;
    try {
      return JSON.parse(
        JSON.stringify(payload, (_, value) =>
          typeof value === "bigint" ? value.toString() : value
        )
      );
    } catch {
      return payload;
    }
  }

  redactPayload(payload: Record<string, unknown>): Record<string, unknown> {
    const cloned: Record<string, unknown> = { ...payload };
    for (const key of Object.keys(cloned)) {
      if (typeof cloned[key] === "string" && /(token|cookie)/i.test(key)) {
        cloned[key] = "[redacted]";
      }
    }
    return cloned;
  }
}
