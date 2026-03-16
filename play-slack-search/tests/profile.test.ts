import assert from 'node:assert/strict';
import test from 'node:test';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

import {
  defaultProfilePath,
  normalizeProfilePath,
} from '../scripts/slack-search/profile.ts';

test('defaultProfilePath は adjutant 配下の標準プロファイルを返す', () => {
  assert.equal(
    defaultProfilePath(),
    resolve(homedir(), '.adjutant/tools/play-slack-search/profile'),
  );
});

test('normalizeProfilePath は ~ をホームディレクトリへ展開する', () => {
  assert.equal(
    normalizeProfilePath('~/slack-profile'),
    resolve(homedir(), 'slack-profile'),
  );
});

test('normalizeProfilePath は相対パスを絶対パスへ解決する', () => {
  assert.equal(normalizeProfilePath('./tmp/profile'), resolve('./tmp/profile'));
});
