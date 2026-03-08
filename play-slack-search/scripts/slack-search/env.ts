import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ENV_FILENAMES = ['.env', '.env.local'] as const;

export const PLAY_SLACK_SEARCH_PROFILE_ENV = 'PLAY_SLACK_SEARCH_PROFILE';
export const PLAY_SLACK_SEARCH_SESSION_ENV = 'PLAY_SLACK_SEARCH_SESSION';
export const PLAY_SLACK_SEARCH_WORKSPACE_URL_ENV =
  'PLAY_SLACK_SEARCH_WORKSPACE_URL';

export function loadPackageEnv(env: NodeJS.ProcessEnv = process.env): void {
  const preservedKeys = new Set(
    Object.entries(env)
      .filter(([, value]) => value !== undefined)
      .map(([key]) => key),
  );

  for (const filename of ENV_FILENAMES) {
    const envPath = resolve(PACKAGE_ROOT, filename);
    if (!existsSync(envPath)) {
      continue;
    }

    const entries = parseDotenv(readFileSync(envPath, 'utf8'));
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
    if (!line || line.startsWith('#')) {
      continue;
    }

    const normalizedLine = line.startsWith('export ')
      ? line.slice('export '.length).trim()
      : line;
    const separatorIndex = normalizedLine.indexOf('=');
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
