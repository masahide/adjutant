import assert from 'node:assert/strict';
import test from 'node:test';

import type { SessionInfo } from '../scripts/slack-search/contracts.ts';
import {
  navigatePlaywrightSession,
  openPlaywrightSessionForLogin,
  openPlaywrightSession,
  parseSessionListOutput,
  prepareSession,
  runInteractiveLogin,
} from '../scripts/slack-search/session.ts';

const TEST_PROFILE = '/Users/test-user/.playwright-cli/slack';
const OTHER_PROFILE = '/Users/test-user/.playwright-cli/other';
const CLONED_PROFILE = '/tmp/play-slack-search-profile-clone/slack';
const PROFILE_IN_USE_ERROR = `Browser is already in use for ${TEST_PROFILE}`;

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
      rawUserDataDir: TEST_PROFILE,
      status: 'open',
    },
  ];

  const prepared = prepareSession(
    {
      profile: TEST_PROFILE,
      requestedSession: 'auto',
      workspaceUrl: 'https://example.slack.com',
    },
    {
      closeSession: (session) => calls.push(`close:${session}`),
      listSessions: () => sessions,
      log: () => {},
      openSession: ({ profile }) => {
        calls.push('open');
        return profile;
      },
    },
  );

  assert.deepEqual(prepared, {
    debug: {
      sessionMessages: [
        'session.list elapsed=0.0s count=1',
        'session.ready reused=reusable elapsed=0.0s',
      ],
    },
    openedSession: null,
    profile: TEST_PROFILE,
    session: 'reusable',
  });
  assert.deepEqual(calls, []);
});

test('prepareSession は requested session のプロファイル不一致時に close して open し直す', () => {
  const calls: string[] = [];
  const sessions: SessionInfo[] = [
    {
      name: 'auto',
      rawUserDataDir: OTHER_PROFILE,
      status: 'open',
    },
  ];

  const prepared = prepareSession(
    {
      profile: TEST_PROFILE,
      requestedSession: 'auto',
      workspaceUrl: 'https://example.slack.com',
    },
    {
      closeSession: (session) => calls.push(`close:${session}`),
      listSessions: () => sessions,
      log: () => {},
      openSession: ({ profile, requestedSession }) => {
        calls.push(`open:${requestedSession}`);
        return profile;
      },
    },
  );

  assert.deepEqual(prepared, {
    debug: {
      sessionMessages: [
        'session.list elapsed=0.0s count=1',
        `session.close requested=auto reason=profile-mismatch profile=${OTHER_PROFILE}`,
        `session.ready opened=auto profile=${TEST_PROFILE} elapsed=0.0s open_elapsed=0.0s`,
      ],
    },
    openedSession: 'auto',
    profile: TEST_PROFILE,
    session: 'auto',
  });
  assert.deepEqual(calls, ['close:auto', 'open:auto']);
});

test('prepareSession は requested session とは別でも同じプロファイルの open session を優先する', () => {
  const calls: string[] = [];
  const sessions: SessionInfo[] = [
    {
      name: 'auto',
      rawUserDataDir: OTHER_PROFILE,
      status: 'open',
    },
    {
      name: 'shared',
      rawUserDataDir: TEST_PROFILE,
      status: 'open',
    },
  ];

  const prepared = prepareSession(
    {
      profile: TEST_PROFILE,
      requestedSession: 'auto',
      workspaceUrl: 'https://example.slack.com',
    },
    {
      closeSession: (session) => calls.push(`close:${session}`),
      listSessions: () => sessions,
      log: () => {},
      openSession: ({ profile }) => {
        calls.push('open');
        return profile;
      },
    },
  );

  assert.deepEqual(prepared, {
    debug: {
      sessionMessages: [
        'session.list elapsed=0.0s count=2',
        `session.close requested=auto reason=profile-mismatch profile=${OTHER_PROFILE}`,
        'session.ready reused=shared elapsed=0.0s',
      ],
    },
    openedSession: null,
    profile: TEST_PROFILE,
    session: 'shared',
  });
  assert.deepEqual(calls, ['close:auto']);
});

test('runInteractiveLogin は同じ profile の open session を再利用して workspace を開く', () => {
  const calls: string[] = [];
  const sessions: SessionInfo[] = [
    {
      name: 'auto',
      rawUserDataDir: OTHER_PROFILE,
      status: 'open',
    },
    {
      name: 'shared',
      rawUserDataDir: TEST_PROFILE,
      status: 'open',
    },
  ];

  const prepared = runInteractiveLogin(
    {
      profile: TEST_PROFILE,
      requestedSession: 'auto',
      workspaceUrl: 'https://example.slack.com',
    },
    {
      listSessions: () => sessions,
      log: () => {},
      navigateSession: (session, workspaceUrl) => {
        calls.push(`goto:${session}:${workspaceUrl}`);
      },
      openSession: () => {
        calls.push('open');
        return 'auto';
      },
    },
  );

  assert.deepEqual(prepared, {
    debug: {
      sessionMessages: [
        'session.list elapsed=0.0s count=2',
        'session.ready reused=shared elapsed=0.0s',
        'login.instructions session=shared profile=/Users/test-user/.playwright-cli/slack action=open-browser-and-return-control',
        'login.done session=shared elapsed=0.0s',
      ],
    },
    openedSession: null,
    profile: TEST_PROFILE,
    session: 'shared',
  });
  assert.deepEqual(calls, ['goto:shared:https://example.slack.com']);
});

test('runInteractiveLogin は新しい session を open してすぐ返す', () => {
  const calls: string[] = [];

  const prepared = runInteractiveLogin(
    {
      profile: TEST_PROFILE,
      requestedSession: 'auto',
      workspaceUrl: 'https://example.slack.com',
    },
    {
      listSessions: () => [],
      log: () => {},
      navigateSession: () => {
        calls.push('goto');
      },
      openSession: ({ requestedSession }) => {
        calls.push(`open:${requestedSession}`);
        return requestedSession;
      },
    },
  );

  assert.deepEqual(prepared, {
    debug: {
      sessionMessages: [
        'session.list elapsed=0.0s count=0',
        `session.ready opened=auto profile=${TEST_PROFILE} elapsed=0.0s open_elapsed=0.0s`,
        `login.instructions session=auto profile=${TEST_PROFILE} action=open-browser-and-return-control`,
        'login.done session=auto elapsed=0.0s',
      ],
    },
    openedSession: 'auto',
    profile: TEST_PROFILE,
    session: 'auto',
  });
  assert.deepEqual(calls, ['open:auto']);
});

test('openPlaywrightSessionForLogin は open コマンドを使う', () => {
  const calls: string[][] = [];

  const session = openPlaywrightSessionForLogin(
    {
      profile: TEST_PROFILE,
      requestedSession: 'auto',
      workspaceUrl: 'https://example.slack.com',
    },
    (args) => {
      calls.push(args);
      return '';
    },
    () => {},
  );

  assert.equal(session, 'auto');
  assert.deepEqual(calls, [
    [
      '-s=auto',
      'open',
      '--headed',
      `--profile=${TEST_PROFILE}`,
      'https://example.slack.com',
    ],
  ]);
});

test('navigatePlaywrightSession は goto コマンドを使う', () => {
  const calls: string[][] = [];

  navigatePlaywrightSession(
    'shared',
    'https://example.slack.com',
    (args) => {
      calls.push(args);
      return '';
    },
    () => {},
  );

  assert.deepEqual(calls, [['-s=shared', 'goto', 'https://example.slack.com']]);
});

test('openPlaywrightSession は browser in use エラー時に close 後 isolated で再試行する', () => {
  const calls: string[][] = [];

  const openedProfile = openPlaywrightSession(
    {
      profile: TEST_PROFILE,
      requestedSession: 'auto',
      workspaceUrl: 'https://example.slack.com',
    },
    (args) => {
      calls.push(args);
      if (args[1] === 'open' && !args.includes('--isolated')) {
        throw new Error(PROFILE_IN_USE_ERROR);
      }
      return '';
    },
    undefined,
    () => {},
  );

  assert.equal(openedProfile, TEST_PROFILE);
  assert.deepEqual(calls, [
    [
      '-s=auto',
      'open',
      `--profile=${TEST_PROFILE}`,
      'https://example.slack.com',
    ],
    ['-s=auto', 'close'],
    [
      '-s=auto',
      'open',
      `--profile=${TEST_PROFILE}`,
      'https://example.slack.com',
    ],
    [
      '-s=auto',
      'open',
      '--isolated',
      `--profile=${TEST_PROFILE}`,
      'https://example.slack.com',
    ],
  ]);
});

test('openPlaywrightSession は別種の open エラーをそのまま投げる', () => {
  assert.throws(
    () =>
      openPlaywrightSession(
        {
          profile: TEST_PROFILE,
          requestedSession: 'auto',
          workspaceUrl: 'https://example.slack.com',
        },
        () => {
          throw new Error('unexpected open failure');
        },
        undefined,
        () => {},
      ),
    /unexpected open failure/,
  );
});

test('openPlaywrightSession は cloned profile fallback を使って復旧する', () => {
  const calls: string[][] = [];

  const openedProfile = openPlaywrightSession(
    {
      profile: TEST_PROFILE,
      requestedSession: 'auto',
      workspaceUrl: 'https://example.slack.com',
    },
    (args) => {
      calls.push(args);
      if (
        args[1] === 'open' &&
        args.some((arg) => arg === `--profile=${TEST_PROFILE}`)
      ) {
        throw new Error(PROFILE_IN_USE_ERROR);
      }
      return '';
    },
    () => CLONED_PROFILE,
    () => {},
  );

  assert.equal(openedProfile, CLONED_PROFILE);
  assert.deepEqual(calls, [
    [
      '-s=auto',
      'open',
      `--profile=${TEST_PROFILE}`,
      'https://example.slack.com',
    ],
    ['-s=auto', 'close'],
    [
      '-s=auto',
      'open',
      `--profile=${TEST_PROFILE}`,
      'https://example.slack.com',
    ],
    [
      '-s=auto',
      'open',
      '--isolated',
      `--profile=${TEST_PROFILE}`,
      'https://example.slack.com',
    ],
    ['-s=auto', 'close'],
    [
      '-s=auto',
      'open',
      `--profile=${CLONED_PROFILE}`,
      'https://example.slack.com',
    ],
  ]);
});

test('openPlaywrightSession は isolated 未対応でも cloned profile fallback を使う', () => {
  const calls: string[][] = [];

  const openedProfile = openPlaywrightSession(
    {
      profile: TEST_PROFILE,
      requestedSession: 'auto',
      workspaceUrl: 'https://example.slack.com',
    },
    (args) => {
      calls.push(args);
      if (
        args[1] === 'open' &&
        args.some((arg) => arg === `--profile=${TEST_PROFILE}`)
      ) {
        if (args.includes('--isolated')) {
          throw new Error("error: unknown '--isolated' option");
        }
        throw new Error(PROFILE_IN_USE_ERROR);
      }
      return '';
    },
    () => CLONED_PROFILE,
    () => {},
  );

  assert.equal(openedProfile, CLONED_PROFILE);
  assert.deepEqual(calls, [
    [
      '-s=auto',
      'open',
      `--profile=${TEST_PROFILE}`,
      'https://example.slack.com',
    ],
    ['-s=auto', 'close'],
    [
      '-s=auto',
      'open',
      `--profile=${TEST_PROFILE}`,
      'https://example.slack.com',
    ],
    [
      '-s=auto',
      'open',
      '--isolated',
      `--profile=${TEST_PROFILE}`,
      'https://example.slack.com',
    ],
    ['-s=auto', 'close'],
    [
      '-s=auto',
      'open',
      `--profile=${CLONED_PROFILE}`,
      'https://example.slack.com',
    ],
  ]);
});

test('openPlaywrightSession は close と isolated でも browser in use が続くと復旧手順付きで失敗する', () => {
  assert.throws(
    () =>
      openPlaywrightSession(
        {
          profile: TEST_PROFILE,
          requestedSession: 'auto',
          workspaceUrl: 'https://example.slack.com',
        },
        (args) => {
          if (args[1] === 'close') {
            return '';
          }
          throw new Error(PROFILE_IN_USE_ERROR);
        },
        () => CLONED_PROFILE,
        () => {},
      ),
    /cloned profile fallback/,
  );
});
