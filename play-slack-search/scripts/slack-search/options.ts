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
    limit: null,
    listChannels: false,
    listUsers: false,
    profile:
      readDefaultEnvValue(env, PLAY_SLACK_SEARCH_PROFILE_ENV) ??
      defaultProfilePath(),
    query: '',
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
    if ((arg === '--query' || arg === '-q') && next) {
      parsedOptions.query = next;
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
    if (arg === '--list-users') {
      parsedOptions.listUsers = true;
      continue;
    }
    if ((arg === '--output' || arg === '-o') && next) {
      parsedOptions.output = next;
      index += 1;
      continue;
    }
    if (arg.startsWith('--output=')) {
      parsedOptions.output = arg.slice('--output='.length);
      continue;
    }
    if (arg === '--session' && next) {
      parsedOptions.session = next;
      index += 1;
      continue;
    }
    if (arg.startsWith('--session=')) {
      parsedOptions.session = arg.slice('--session='.length);
      continue;
    }
    if (arg === '--profile' && next) {
      parsedOptions.profile = next;
      index += 1;
      continue;
    }
    if (arg.startsWith('--profile=')) {
      parsedOptions.profile = arg.slice('--profile='.length);
      continue;
    }
    if (arg === '--workspace-url' && next) {
      parsedOptions.workspaceUrl = next;
      index += 1;
      continue;
    }
    if (arg.startsWith('--workspace-url=')) {
      parsedOptions.workspaceUrl = arg.slice('--workspace-url='.length);
      continue;
    }
    if (arg === '--limit' && next) {
      parsedOptions.limit = parsePositiveInteger(next, '--limit');
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

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (parsedOptions.listChannels && parsedOptions.listUsers) {
    throw new Error(
      '`--list-channels` and `--list-users` cannot be used together.',
    );
  }
  if (
    (parsedOptions.listChannels || parsedOptions.listUsers) &&
    parsedOptions.query.trim()
  ) {
    throw new Error('`--query` cannot be used together with list modes.');
  }
  if (
    !parsedOptions.listChannels &&
    !parsedOptions.listUsers &&
    !parsedOptions.query.trim()
  ) {
    throw new Error(
      '`--query` is required unless `--list-channels` or `--list-users` is specified.',
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
    '',
    'Options:',
    '  --query, -q          Slack search query. Required unless --list-channels or --list-users is used.',
    '  --list-channels      Emit channel info list from Slack client state.',
    '  --list-users         Emit user info list from Slack client state.',
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

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer: ${value}`);
  }
  return parsed;
}

function readDefaultEnvValue(
  env: NodeJS.ProcessEnv,
  key: string,
): string | undefined {
  const value = env[key]?.trim();
  return value && value.length > 0 ? value : undefined;
}
