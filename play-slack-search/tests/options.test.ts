import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_SESSION } from '../scripts/slack-search/contracts.ts';
import {
  PLAY_SLACK_SEARCH_PROFILE_ENV,
  PLAY_SLACK_SEARCH_SESSION_ENV,
  PLAY_SLACK_SEARCH_WORKSPACE_URL_ENV,
} from '../scripts/slack-search/env.ts';
import { parseArgs } from '../scripts/slack-search/options.ts';

test('parseArgs は検索実行時のデフォルト値を補完する', () => {
  const options = parseArgs(['--query', 'from:me'], {
    env: {
      [PLAY_SLACK_SEARCH_WORKSPACE_URL_ENV]: 'https://example.slack.com',
    },
  });

  assert.deepEqual(options, {
    close: false,
    limit: null,
    listChannels: false,
    listUsers: false,
    profile: options.profile,
    query: 'from:me',
    session: DEFAULT_SESSION,
    workspaceUrl: 'https://example.slack.com',
  });
  assert.match(options.profile, /\.playwright-cli\/slack$/);
});

test('parseArgs は .env 相当のデフォルト値を補完する', () => {
  const options = parseArgs(['--query', 'from:me'], {
    env: {
      [PLAY_SLACK_SEARCH_PROFILE_ENV]: '~/custom-profile',
      [PLAY_SLACK_SEARCH_SESSION_ENV]: 'shared-session',
      [PLAY_SLACK_SEARCH_WORKSPACE_URL_ENV]: 'https://example.slack.com',
    },
  });

  assert.equal(options.profile, '~/custom-profile');
  assert.equal(options.session, 'shared-session');
  assert.equal(options.workspaceUrl, 'https://example.slack.com');
});

test('parseArgs は equals 形式と一覧取得オプションを解釈する', () => {
  const options = parseArgs([
    '--list-channels',
    '--limit=3',
    '--session=my-session',
    '--profile=~/custom-profile',
    '--workspace-url=https://example.slack.com',
    '--output=./tmp/result.json',
    '--close',
  ]);

  assert.equal(options.listChannels, true);
  assert.equal(options.limit, 3);
  assert.equal(options.session, 'my-session');
  assert.equal(options.profile, '~/custom-profile');
  assert.equal(options.workspaceUrl, 'https://example.slack.com');
  assert.equal(options.output, './tmp/result.json');
  assert.equal(options.close, true);
});

test('parseArgs は list-users を解釈する', () => {
  const options = parseArgs([
    '--list-users',
    '--limit=5',
    '--workspace-url=https://example.slack.com',
  ]);

  assert.equal(options.listChannels, false);
  assert.equal(options.listUsers, true);
  assert.equal(options.limit, 5);
});

test('parseArgs は query なしの検索実行を拒否する', () => {
  assert.throws(() => parseArgs([]), /`--query` is required/);
});

test('parseArgs は workspaceUrl 未設定を拒否する', () => {
  assert.throws(
    () => parseArgs(['--query', 'from:me']),
    /PLAY_SLACK_SEARCH_WORKSPACE_URL/,
  );
});

test('parseArgs は list-channels と query の併用を拒否する', () => {
  assert.throws(
    () =>
      parseArgs(['--list-channels', '--query', 'from:me'], {
        env: {
          [PLAY_SLACK_SEARCH_WORKSPACE_URL_ENV]: 'https://example.slack.com',
        },
      }),
    /cannot be used together/,
  );
});

test('parseArgs は list-users と query の併用を拒否する', () => {
  assert.throws(
    () =>
      parseArgs(['--list-users', '--query', 'from:me'], {
        env: {
          [PLAY_SLACK_SEARCH_WORKSPACE_URL_ENV]: 'https://example.slack.com',
        },
      }),
    /cannot be used together/,
  );
});

test('parseArgs は list-channels と list-users の併用を拒否する', () => {
  assert.throws(
    () =>
      parseArgs(['--list-channels', '--list-users'], {
        env: {
          [PLAY_SLACK_SEARCH_WORKSPACE_URL_ENV]: 'https://example.slack.com',
        },
      }),
    /cannot be used together/,
  );
});

test('parseArgs は不正な limit を拒否する', () => {
  assert.throws(
    () =>
      parseArgs(['--query', 'from:me', '--limit=0'], {
        env: {
          [PLAY_SLACK_SEARCH_WORKSPACE_URL_ENV]: 'https://example.slack.com',
        },
      }),
    /positive integer/,
  );
});

test('parseArgs は未知の引数を拒否する', () => {
  assert.throws(
    () =>
      parseArgs(['--query', 'from:me', '--bogus'], {
        env: {
          [PLAY_SLACK_SEARCH_WORKSPACE_URL_ENV]: 'https://example.slack.com',
        },
      }),
    /Unknown argument/,
  );
});
