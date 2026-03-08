import assert from 'node:assert/strict';
import test from 'node:test';

import { runListChannelsInBrowser } from '../scripts/slack-search/browser/list-channels.ts';
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
      limit: null,
      listChannels: false,
      listUsers: false,
      query: 'from:me',
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
      limit: null,
      listChannels: true,
      listUsers: false,
      query: '',
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
      limit: null,
      listChannels: false,
      listUsers: true,
      query: '',
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
    limit: UNBOUNDED_LIMIT,
    workspaceUrl: 'https://example.slack.com',
  });
  assert.deepEqual(calls[1]?.args, ['-s=auto', 'run-code', 'SERIALIZED_USERS']);
});
