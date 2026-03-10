import assert from 'node:assert/strict';
import test from 'node:test';

import { runHydrateStateInBrowser } from '../scripts/slack-search/browser/hydrate.ts';
import { runListChannelsInBrowser } from '../scripts/slack-search/browser/list-channels.ts';
import { runResolveChannelInBrowser } from '../scripts/slack-search/browser/resolve-channel.ts';
import { runListUsersInBrowser } from '../scripts/slack-search/browser/list-users.ts';
import { runSlackSearchInBrowser } from '../scripts/slack-search/browser/search.ts';
import {
  DEFAULT_SEARCH_LIMIT,
  UNBOUNDED_LIMIT,
} from '../scripts/slack-search/contracts.ts';
import { executeSlackCommand } from '../scripts/slack-search/command.ts';

test('executeSlackCommand は検索モードで search runner を使い既定 limit を補う', () => {
  const calls: Array<{ args?: string[]; input?: unknown; runner?: unknown }> =
    [];
  const result = { mode: 'search' as const, results: [] };

  const payload = executeSlackCommand(
    {
      hydrate: false,
      limit: null,
      listChannels: false,
      listUsers: false,
      query: 'from:me',
      resolveChannelIds: [],
      workspaceUrl: 'https://example.slack.com',
    },
    'auto',
    {
      runJson: <T>(args: string[]) => {
        calls.push({ args });
        return result as T;
      },
      serializeBrowserCode: (runner, input) => {
        calls.push({ input, runner });
        return 'SERIALIZED_SEARCH';
      },
    },
  );

  assert.equal(payload, result);
  assert.equal(calls[0]?.runner, runSlackSearchInBrowser);
  assert.deepEqual(calls[0]?.input, {
    limit: DEFAULT_SEARCH_LIMIT,
    query: 'from:me',
    workspaceUrl: 'https://example.slack.com',
  });
  assert.deepEqual(calls[1]?.args, [
    '-s=auto',
    'run-code',
    'SERIALIZED_SEARCH',
  ]);
});

test('executeSlackCommand は一覧モードで list runner を使い無制限 limit を補う', () => {
  const calls: Array<{ args?: string[]; input?: unknown; runner?: unknown }> =
    [];
  const result = { mode: 'list-channels' as const, channels: [] };

  const payload = executeSlackCommand(
    {
      hydrate: false,
      limit: null,
      listChannels: true,
      listUsers: false,
      query: '',
      resolveChannelIds: [],
      workspaceUrl: 'https://example.slack.com',
    },
    'auto',
    {
      runJson: <T>(args: string[]) => {
        calls.push({ args });
        return result as T;
      },
      serializeBrowserCode: (runner, input) => {
        calls.push({ input, runner });
        return 'SERIALIZED_LIST';
      },
    },
  );

  assert.equal(payload, result);
  assert.equal(calls[0]?.runner, runListChannelsInBrowser);
  assert.deepEqual(calls[0]?.input, {
    hydrate: false,
    limit: UNBOUNDED_LIMIT,
    workspaceUrl: 'https://example.slack.com',
  });
  assert.deepEqual(calls[1]?.args, ['-s=auto', 'run-code', 'SERIALIZED_LIST']);
});

test('executeSlackCommand はユーザー一覧モードで user runner を使い無制限 limit を補う', () => {
  const calls: Array<{ args?: string[]; input?: unknown; runner?: unknown }> =
    [];
  const result = { mode: 'list-users' as const, users: [] };

  const payload = executeSlackCommand(
    {
      hydrate: false,
      limit: null,
      listChannels: false,
      listUsers: true,
      query: '',
      resolveChannelIds: [],
      workspaceUrl: 'https://example.slack.com',
    },
    'auto',
    {
      runJson: <T>(args: string[]) => {
        calls.push({ args });
        return result as T;
      },
      serializeBrowserCode: (runner, input) => {
        calls.push({ input, runner });
        return 'SERIALIZED_USERS';
      },
    },
  );

  assert.equal(payload, result);
  assert.equal(calls[0]?.runner, runListUsersInBrowser);
  assert.deepEqual(calls[0]?.input, {
    hydrate: false,
    limit: UNBOUNDED_LIMIT,
    workspaceUrl: 'https://example.slack.com',
  });
  assert.deepEqual(calls[1]?.args, ['-s=auto', 'run-code', 'SERIALIZED_USERS']);
});

test('executeSlackCommand は hydrate 指定時に一覧取得前に hydrate runner を実行する', () => {
  const calls: Array<{ args?: string[]; input?: unknown; runner?: unknown }> =
    [];
  const result = { mode: 'list-channels' as const, channels: [] };

  const payload = executeSlackCommand(
    {
      hydrate: true,
      limit: null,
      listChannels: true,
      listUsers: false,
      query: '',
      resolveChannelIds: [],
      workspaceUrl: 'https://example.slack.com',
    },
    'auto',
    {
      runJson: <T>(args: string[]) => {
        calls.push({ args });
        return result as T;
      },
      serializeBrowserCode: (runner, input) => {
        calls.push({ input, runner });
        if (runner === runHydrateStateInBrowser) {
          return 'SERIALIZED_HYDRATE';
        }
        return 'SERIALIZED_LIST';
      },
    },
  );

  assert.equal(payload, result);
  assert.equal(calls[0]?.runner, runHydrateStateInBrowser);
  assert.deepEqual(calls[0]?.input, {
    target: 'channels',
    workspaceUrl: 'https://example.slack.com',
  });
  assert.deepEqual(calls[1]?.args, [
    '-s=auto',
    'run-code',
    'SERIALIZED_HYDRATE',
  ]);
  assert.equal(calls[2]?.runner, runListChannelsInBrowser);
  assert.deepEqual(calls[2]?.input, {
    hydrate: true,
    limit: UNBOUNDED_LIMIT,
    workspaceUrl: 'https://example.slack.com',
  });
  assert.deepEqual(calls[3]?.args, ['-s=auto', 'run-code', 'SERIALIZED_LIST']);
});

test('executeSlackCommand は channel resolve モードで resolver runner を使う', () => {
  const calls: Array<{ args?: string[]; input?: unknown; runner?: unknown }> =
    [];
  const result = {
    channels: [
      {
        channelId: 'C12345678',
        channelName: 'general',
        resolved: true,
        source: 'reduxPersistence.channels' as const,
        stateKey: 'persist:slack-client-T123-1',
      },
      {
        channelId: 'C23456789',
        channelName: 'random',
        resolved: true,
        source: 'search.suggestion' as const,
        stateKey: null,
      },
    ],
    listUrl: 'https://example.slack.com/client/T123/C12345678',
    mode: 'resolve-channels' as const,
    pageTitle: 'Channel general - Slack',
  };

  const payload = executeSlackCommand(
    {
      hydrate: false,
      limit: null,
      listChannels: false,
      listUsers: false,
      query: '',
      resolveChannelIds: ['C12345678', 'C23456789'],
      workspaceUrl: 'https://example.slack.com',
    },
    'auto',
    {
      runJson: <T>(args: string[]) => {
        calls.push({ args });
        return result as T;
      },
      serializeBrowserCode: (runner, input) => {
        calls.push({ input, runner });
        return 'SERIALIZED_RESOLVE';
      },
    },
  );

  assert.equal(payload, result);
  assert.equal(calls[0]?.runner, runResolveChannelInBrowser);
  assert.deepEqual(calls[0]?.input, {
    channelIds: ['C12345678', 'C23456789'],
    workspaceUrl: 'https://example.slack.com',
  });
  assert.deepEqual(calls[1]?.args, [
    '-s=auto',
    'run-code',
    'SERIALIZED_RESOLVE',
  ]);
});
