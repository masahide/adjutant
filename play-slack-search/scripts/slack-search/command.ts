import {
  DEFAULT_SEARCH_LIMIT,
  UNBOUNDED_LIMIT,
  type ChannelListPayload,
  type Options,
  type PayloadBody,
  type SearchPayload,
  type UserListPayload,
} from './contracts.ts';
import { serializeBrowserCode, runJson } from './playwright-cli.ts';
import { runListChannelsInBrowser } from './browser/list-channels.ts';
import { runListUsersInBrowser } from './browser/list-users.ts';
import { runSlackSearchInBrowser } from './browser/search.ts';

type CommandOptions = Pick<
  Options,
  'limit' | 'listChannels' | 'listUsers' | 'query' | 'workspaceUrl'
>;

interface CommandDependencies {
  runJson: typeof runJson;
  serializeBrowserCode: typeof serializeBrowserCode;
}

const defaultCommandDependencies: CommandDependencies = {
  runJson,
  serializeBrowserCode,
};

export function executeSlackCommand(
  options: CommandOptions,
  session: string,
  dependencies: CommandDependencies = defaultCommandDependencies,
): PayloadBody {
  if (options.listChannels) {
    return dependencies.runJson<ChannelListPayload>([
      `-s=${session}`,
      'run-code',
      dependencies.serializeBrowserCode(runListChannelsInBrowser, {
        limit: options.limit ?? UNBOUNDED_LIMIT,
        workspaceUrl: options.workspaceUrl,
      }),
    ]);
  }

  if (options.listUsers) {
    return dependencies.runJson<UserListPayload>([
      `-s=${session}`,
      'run-code',
      dependencies.serializeBrowserCode(runListUsersInBrowser, {
        limit: options.limit ?? UNBOUNDED_LIMIT,
        workspaceUrl: options.workspaceUrl,
      }),
    ]);
  }

  return dependencies.runJson<SearchPayload>([
    `-s=${session}`,
    'run-code',
    dependencies.serializeBrowserCode(runSlackSearchInBrowser, {
      limit: options.limit ?? DEFAULT_SEARCH_LIMIT,
      query: options.query,
      workspaceUrl: options.workspaceUrl,
    }),
  ]);
}
