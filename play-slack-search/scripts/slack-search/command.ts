import {
  DEFAULT_SEARCH_LIMIT,
  UNBOUNDED_LIMIT,
  type ChannelListPayload,
  type HydratePayload,
  type Options,
  type PayloadBody,
  type ResolveChannelsPayload,
  type SearchPayload,
  type UserListPayload,
} from './contracts.ts';
import { runHydrateStateInBrowser } from './browser/hydrate.ts';
import { serializeBrowserCode, runJson } from './playwright-cli.ts';
import { runListChannelsInBrowser } from './browser/list-channels.ts';
import { runResolveChannelInBrowser } from './browser/resolve-channel.ts';
import { runListUsersInBrowser } from './browser/list-users.ts';
import { runSlackSearchInBrowser } from './browser/search.ts';

type CommandOptions = Pick<
  Options,
  | 'hydrate'
  | 'limit'
  | 'listChannels'
  | 'listUsers'
  | 'query'
  | 'resolveChannelIds'
  | 'workspaceUrl'
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
    if (options.hydrate) {
      dependencies.runJson<HydratePayload>([
        `-s=${session}`,
        'run-code',
        dependencies.serializeBrowserCode(runHydrateStateInBrowser, {
          target: 'channels',
          workspaceUrl: options.workspaceUrl,
        }),
      ]);
    }

    return dependencies.runJson<ChannelListPayload>([
      `-s=${session}`,
      'run-code',
      dependencies.serializeBrowserCode(runListChannelsInBrowser, {
        hydrate: options.hydrate,
        limit: options.limit ?? UNBOUNDED_LIMIT,
        workspaceUrl: options.workspaceUrl,
      }),
    ]);
  }

  if (options.listUsers) {
    if (options.hydrate) {
      dependencies.runJson<HydratePayload>([
        `-s=${session}`,
        'run-code',
        dependencies.serializeBrowserCode(runHydrateStateInBrowser, {
          target: 'users',
          workspaceUrl: options.workspaceUrl,
        }),
      ]);
    }

    return dependencies.runJson<UserListPayload>([
      `-s=${session}`,
      'run-code',
      dependencies.serializeBrowserCode(runListUsersInBrowser, {
        hydrate: options.hydrate,
        limit: options.limit ?? UNBOUNDED_LIMIT,
        workspaceUrl: options.workspaceUrl,
      }),
    ]);
  }

  if (options.resolveChannelIds.length > 0) {
    return dependencies.runJson<ResolveChannelsPayload>([
      `-s=${session}`,
      'run-code',
      dependencies.serializeBrowserCode(runResolveChannelInBrowser, {
        channelIds: options.resolveChannelIds,
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
