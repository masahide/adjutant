import process from 'node:process';
import { DEFAULT_SESSION, type Options } from './contracts.ts';
import {
  PLAY_SLACK_SEARCH_PROFILE_ENV,
  PLAY_SLACK_SEARCH_SESSION_ENV,
  PLAY_SLACK_SEARCH_WORKSPACE_URL_ENV,
} from './env.ts';
import { defaultProfilePath } from './profile.ts';

interface ParseArgsOptions {
  env?: NodeJS.ProcessEnv;
}

export function parseArgs(
  argv: string[],
  parseOptions: ParseArgsOptions = {},
): Options {
  const env = parseOptions.env ?? process.env;
  const parsedOptions: Options = {
    close: false,
    hydrate: false,
    limit: null,
    listChannels: false,
    listUsers: false,
    profile:
      readDefaultEnvValue(env, PLAY_SLACK_SEARCH_PROFILE_ENV) ??
      defaultProfilePath(),
    query: '',
    resolveChannelIds: [],
    session:
      readDefaultEnvValue(env, PLAY_SLACK_SEARCH_SESSION_ENV) ??
      DEFAULT_SESSION,
    workspaceUrl:
      readDefaultEnvValue(env, PLAY_SLACK_SEARCH_WORKSPACE_URL_ENV) ?? '',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === '--help' || arg === '-h') {
      printHelp(env);
      process.exit(0);
    }
    if (arg === '--query' || arg === '-q') {
      parsedOptions.query = readRequiredOptionValue(arg, next);
      index += 1;
      continue;
    }
    if (arg.startsWith('--query=')) {
      parsedOptions.query = arg.slice('--query='.length);
      continue;
    }
    if (arg === '--list-channels') {
      parsedOptions.listChannels = true;
      continue;
    }
    if (arg === '--list-users' || arg === '--list-user') {
      parsedOptions.listUsers = true;
      continue;
    }
    if (arg === '--resolve-channel-id') {
      parsedOptions.resolveChannelIds.push(
        ...parseResolveChannelIds(readRequiredOptionValue(arg, next)),
      );
      index += 1;
      continue;
    }
    if (arg.startsWith('--resolve-channel-id=')) {
      parsedOptions.resolveChannelIds.push(
        ...parseResolveChannelIds(arg.slice('--resolve-channel-id='.length)),
      );
      continue;
    }
    if (arg === '--output' || arg === '-o') {
      parsedOptions.output = readRequiredOptionValue(arg, next);
      index += 1;
      continue;
    }
    if (arg.startsWith('--output=')) {
      parsedOptions.output = arg.slice('--output='.length);
      continue;
    }
    if (arg === '--session') {
      parsedOptions.session = readRequiredOptionValue(arg, next);
      index += 1;
      continue;
    }
    if (arg.startsWith('--session=')) {
      parsedOptions.session = arg.slice('--session='.length);
      continue;
    }
    if (arg === '--profile') {
      parsedOptions.profile = readRequiredOptionValue(arg, next);
      index += 1;
      continue;
    }
    if (arg.startsWith('--profile=')) {
      parsedOptions.profile = arg.slice('--profile='.length);
      continue;
    }
    if (arg === '--workspace-url') {
      parsedOptions.workspaceUrl = readRequiredOptionValue(arg, next);
      index += 1;
      continue;
    }
    if (arg.startsWith('--workspace-url=')) {
      parsedOptions.workspaceUrl = arg.slice('--workspace-url='.length);
      continue;
    }
    if (arg === '--limit') {
      parsedOptions.limit = parsePositiveInteger(
        readRequiredOptionValue(arg, next),
        '--limit',
      );
      index += 1;
      continue;
    }
    if (arg.startsWith('--limit=')) {
      parsedOptions.limit = parsePositiveInteger(
        arg.slice('--limit='.length),
        '--limit',
      );
      continue;
    }
    if (arg === '--close') {
      parsedOptions.close = true;
      continue;
    }
    if (arg === '--hydrate') {
      parsedOptions.hydrate = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  const activeModeCount = [
    parsedOptions.listChannels,
    parsedOptions.listUsers,
    parsedOptions.resolveChannelIds.length > 0,
  ].filter(Boolean).length;

  if (activeModeCount > 1) {
    throw new Error(
      '`--list-channels`, `--list-users`, and `--resolve-channel-id` cannot be used together.',
    );
  }
  if (
    (parsedOptions.listChannels ||
      parsedOptions.listUsers ||
      parsedOptions.resolveChannelIds.length > 0) &&
    parsedOptions.query.trim()
  ) {
    throw new Error('`--query` cannot be used together with list modes.');
  }
  if (
    !parsedOptions.listChannels &&
    !parsedOptions.listUsers &&
    parsedOptions.resolveChannelIds.length === 0 &&
    !parsedOptions.query.trim()
  ) {
    throw new Error(
      '`--query` is required unless `--list-channels`, `--list-users`, or `--resolve-channel-id` is specified.',
    );
  }
  if (
    parsedOptions.hydrate &&
    !parsedOptions.listChannels &&
    !parsedOptions.listUsers
  ) {
    throw new Error(
      '`--hydrate` can only be used together with `--list-channels` or `--list-users`.',
    );
  }
  if (!parsedOptions.workspaceUrl.trim()) {
    throw new Error(
      `\`--workspace-url\` is required unless ${PLAY_SLACK_SEARCH_WORKSPACE_URL_ENV} is set.`,
    );
  }

  return parsedOptions;
}

function printHelp(env: NodeJS.ProcessEnv): void {
  const defaultProfile =
    readDefaultEnvValue(env, PLAY_SLACK_SEARCH_PROFILE_ENV) ??
    defaultProfilePath();
  const defaultSession =
    readDefaultEnvValue(env, PLAY_SLACK_SEARCH_SESSION_ENV) ?? DEFAULT_SESSION;
  const lines = [
    'Usage:',
    '  node --experimental-strip-types ./scripts/slack-search.ts --query "from:<@UTEST0001> after:2026-03-03"',
    '  node --experimental-strip-types ./scripts/slack-search.ts --list-channels',
    '  node --experimental-strip-types ./scripts/slack-search.ts --list-users',
    '  node --experimental-strip-types ./scripts/slack-search.ts --resolve-channel-id C12345678 --resolve-channel-id C23456789',
    '',
    'Options:',
    '  --query, -q          Slack search query. Required unless --list-channels, --list-users, or --resolve-channel-id is used.',
    '  --list-channels      Emit channel info list from Slack client state.',
    '  --list-users         Emit user info list from Slack client state.',
    '  --list-user          Alias for --list-users.',
    '  --resolve-channel-id Resolve one or more channel IDs to channel names best-effort. Repeatable, also accepts comma-separated IDs.',
    '  --hydrate            Best-effort warm up Slack client state before list modes.',
    '  --output, -o         Write JSON to a file as well as stdout.',
    `  --session            Playwright session name. Default: ${defaultSession}`,
    `  --profile            Browser profile directory. Default: ${defaultProfile}`,
    `  --workspace-url      Slack workspace URL. Required unless ${PLAY_SLACK_SEARCH_WORKSPACE_URL_ENV} is set.`,
    '  --limit              Maximum rows to emit. Default: 50 for search, all for list modes.',
    '  --close              Close the session after extraction.',
    '  --help, -h           Show this help.',
  ];

  process.stdout.write(`${lines.join('\n')}\n`);
}

function parseResolveChannelIds(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer: ${value}`);
  }
  return parsed;
}

function readRequiredOptionValue(flag: string, value?: string): string {
  if (!value || value.startsWith('-')) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function readDefaultEnvValue(
  env: NodeJS.ProcessEnv,
  key: string,
): string | undefined {
  const value = env[key]?.trim();
  return value && value.length > 0 ? value : undefined;
}
