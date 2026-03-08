import assert from 'node:assert/strict';
import test from 'node:test';

import type { SessionInfo } from '../scripts/slack-search/contracts.ts';
import {
  openPlaywrightSession,
  parseSessionListOutput,
  prepareSession,
} from '../scripts/slack-search/session.ts';

test('parseSessionListOutput は playwright-cli list の出力を構造化する', () => {
  const sessions = parseSessionListOutput(
    `
- auto:
  status: open
  user-data-dir: /Users/example/.playwright-cli/slack
- old:
  status: closed
  user-data-dir: /tmp/old
`.trim(),
  );

  assert.deepEqual(sessions, [
    {
      name: 'auto',
      rawUserDataDir: '/Users/example/.playwright-cli/slack',
      status: 'open',
    },
    {
      name: 'old',
      rawUserDataDir: '/tmp/old',
      status: 'closed',
    },
  ]);
});

test('prepareSession は同じプロファイルの既存 open session を再利用する', () => {
  const calls: string[] = [];
  const sessions: SessionInfo[] = [
    {
      name: 'reusable',
      rawUserDataDir: '/Users/USER/.playwright-cli/slack',
      status: 'open',
    },
  ];

  const prepared = prepareSession(
    {
      profile: '/Users/USER/.playwright-cli/slack',
      requestedSession: 'auto',
      workspaceUrl: 'https://example.slack.com',
    },
    {
      closeSession: (session) => calls.push(`close:${session}`),
      listSessions: () => sessions,
      openSession: () => calls.push('open'),
    },
  );

  assert.deepEqual(prepared, {
    openedSession: null,
    session: 'reusable',
  });
  assert.deepEqual(calls, []);
});

test('prepareSession は requested session のプロファイル不一致時に close して open し直す', () => {
  const calls: string[] = [];
  const sessions: SessionInfo[] = [
    {
      name: 'auto',
      rawUserDataDir: '/Users/USER/.playwright-cli/other',
      status: 'open',
    },
  ];

  const prepared = prepareSession(
    {
      profile: '/Users/USER/.playwright-cli/slack',
      requestedSession: 'auto',
      workspaceUrl: 'https://example.slack.com',
    },
    {
      closeSession: (session) => calls.push(`close:${session}`),
      listSessions: () => sessions,
      openSession: ({ requestedSession }) =>
        calls.push(`open:${requestedSession}`),
    },
  );

  assert.deepEqual(prepared, {
    openedSession: 'auto',
    session: 'auto',
  });
  assert.deepEqual(calls, ['close:auto', 'open:auto']);
});

test('prepareSession は requested session とは別でも同じプロファイルの open session を優先する', () => {
  const calls: string[] = [];
  const sessions: SessionInfo[] = [
    {
      name: 'auto',
      rawUserDataDir: '/Users/USER/.playwright-cli/other',
      status: 'open',
    },
    {
      name: 'shared',
      rawUserDataDir: '/Users/USER/.playwright-cli/slack',
      status: 'open',
    },
  ];

  const prepared = prepareSession(
    {
      profile: '/Users/USER/.playwright-cli/slack',
      requestedSession: 'auto',
      workspaceUrl: 'https://example.slack.com',
    },
    {
      closeSession: (session) => calls.push(`close:${session}`),
      listSessions: () => sessions,
      openSession: () => calls.push('open'),
    },
  );

  assert.deepEqual(prepared, {
    openedSession: null,
    session: 'shared',
  });
  assert.deepEqual(calls, ['close:auto']);
});

test('openPlaywrightSession は browser in use エラー時に close 後 isolated で再試行する', () => {
  const calls: string[][] = [];

  openPlaywrightSession(
    {
      profile: '/Users/USER/.playwright-cli/slack',
      requestedSession: 'auto',
      workspaceUrl: 'https://example.slack.com',
    },
    (args) => {
      calls.push(args);
      if (args[1] === 'open' && !args.includes('--isolated')) {
        throw new Error(
          'Browser is already in use for /Users/USER/.playwright-cli/slack',
        );
      }
      return '';
    },
  );

  assert.deepEqual(calls, [
    [
      '-s=auto',
      'open',
      '--profile=/Users/USER/.playwright-cli/slack',
      'https://example.slack.com',
    ],
    ['-s=auto', 'close'],
    [
      '-s=auto',
      'open',
      '--profile=/Users/USER/.playwright-cli/slack',
      'https://example.slack.com',
    ],
    [
      '-s=auto',
      'open',
      '--isolated',
      '--profile=/Users/USER/.playwright-cli/slack',
      'https://example.slack.com',
    ],
  ]);
});

test('openPlaywrightSession は別種の open エラーをそのまま投げる', () => {
  assert.throws(
    () =>
      openPlaywrightSession(
        {
          profile: '/Users/USER/.playwright-cli/slack',
          requestedSession: 'auto',
          workspaceUrl: 'https://example.slack.com',
        },
        () => {
          throw new Error('unexpected open failure');
        },
      ),
    /unexpected open failure/,
  );
});

test('openPlaywrightSession は close と isolated でも browser in use が続くと復旧手順付きで失敗する', () => {
  assert.throws(
    () =>
      openPlaywrightSession(
        {
          profile: '/Users/USER/.playwright-cli/slack',
          requestedSession: 'auto',
          workspaceUrl: 'https://example.slack.com',
        },
        (args) => {
          if (args[1] === 'close') {
            return '';
          }
          throw new Error(
            'Browser is already in use for /Users/USER/.playwright-cli/slack',
          );
        },
      ),
    /playwright-cli -s=auto close/,
  );
});
