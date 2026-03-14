import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const ENV_FILENAMES = [".env", ".env.local"] as const;

type LoadProjectEnvOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

export function loadProjectEnv(options: LoadProjectEnvOptions = {}): void {
  const env = options.env ?? process.env;
  const rootDir = resolveProjectRoot(options.cwd ?? process.cwd());
  const preservedKeys = new Set(
    Object.entries(env)
      .filter(([, value]) => value !== undefined)
      .map(([key]) => key)
  );

  for (const filename of ENV_FILENAMES) {
    const envPath = join(rootDir, filename);
    if (!existsSync(envPath)) {
      continue;
    }

    const entries = parseDotenv(readFileSync(envPath, "utf8"));
    for (const [key, value] of Object.entries(entries)) {
      if (!preservedKeys.has(key)) {
        env[key] = value;
      }
    }
  }
}

export function parseDotenv(source: string): Record<string, string> {
  const parsed: Record<string, string> = {};

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const normalizedLine = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const separatorIndex = normalizedLine.indexOf("=");
    if (separatorIndex < 1) {
      continue;
    }

    const key = normalizedLine.slice(0, separatorIndex).trim();
    const rawValue = normalizedLine.slice(separatorIndex + 1).trim();
    parsed[key] = stripQuotes(rawValue);
  }

  return parsed;
}

function stripQuotes(input: string): string {
  if (
    (input.startsWith('"') && input.endsWith('"')) ||
    (input.startsWith("'") && input.endsWith("'"))
  ) {
    return input.slice(1, -1);
  }

  return input;
}

function resolveProjectRoot(startDir: string): string {
  let current = resolve(startDir);

  while (true) {
    if (existsSync(join(current, "package.json"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return resolve(startDir);
    }
    current = parent;
  }
}
