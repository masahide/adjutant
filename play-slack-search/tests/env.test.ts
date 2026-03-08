import assert from 'node:assert/strict';
import test from 'node:test';

import {
  loadPackageEnv,
  parseDotenv,
  PLAY_SLACK_SEARCH_WORKSPACE_URL_ENV,
} from '../scripts/slack-search/env.ts';

test('parseDotenv は基本的な key=value を解釈する', () => {
  const parsed = parseDotenv(`
# comment
PLAY_SLACK_SEARCH_WORKSPACE_URL=https://example.slack.com
export PLAY_SLACK_SEARCH_SESSION="shared"
PLAY_SLACK_SEARCH_PROFILE='~/profile'
`);

  assert.deepEqual(parsed, {
    PLAY_SLACK_SEARCH_PROFILE: '~/profile',
    PLAY_SLACK_SEARCH_SESSION: 'shared',
    PLAY_SLACK_SEARCH_WORKSPACE_URL: 'https://example.slack.com',
  });
});

test('loadPackageEnv は既存の環境変数を上書きしない', () => {
  const env: NodeJS.ProcessEnv = {
    [PLAY_SLACK_SEARCH_WORKSPACE_URL_ENV]: 'https://already-set.slack.com',
  };

  loadPackageEnv(env);

  assert.equal(
    env[PLAY_SLACK_SEARCH_WORKSPACE_URL_ENV],
    'https://already-set.slack.com',
  );
});
