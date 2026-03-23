import assert from 'node:assert/strict';
import test from 'node:test';

import { runListChannelsInBrowser } from '../scripts/slack-search/browser/list-channels.ts';
import { runListUsersInBrowser } from '../scripts/slack-search/browser/list-users.ts';
import { runResolveChannelInBrowser } from '../scripts/slack-search/browser/resolve-channel.ts';
import { buildSlackClientStateUnavailableError } from '../scripts/slack-search/browser/runtime-shims.ts';

test('buildSlackClientStateUnavailableError は login 手順付きメッセージを返す', () => {
  const error = buildSlackClientStateUnavailableError({
    action: 'slack.list-users',
    cause: new Error("NotFoundError: Failed to execute 'transaction' on 'IDBDatabase'"),
    workspaceUrl: 'https://example.slack.com',
  });

  assert.match(error.message, /slack\/search mode=login/);
  assert.match(error.message, /https:\/\/example\.slack\.com/);
  assert.match(error.message, /reduxPersistenceStore/);
});

test('runListUsersInBrowser は IndexedDB 失敗を次アクション付きエラーへ変換する', async () => {
  const page = {
    async addInitScript(_input: { content: string }) {},
    async goto(_url: string, _options?: unknown) {},
    async waitForTimeout(_ms: number) {},
    async evaluate<T>(arg: string | ((...args: any[]) => T), ..._args: any[]) {
      if (typeof arg === 'string') {
        return undefined as T;
      }
      throw new Error(
        "NotFoundError: Failed to execute 'transaction' on 'IDBDatabase': One of the specified object stores was not found.",
      );
    },
  };

  await assert.rejects(
    () =>
      runListUsersInBrowser(page, {
        hydrate: false,
        limit: 10,
        workspaceUrl: 'https://example.slack.com',
      }),
    /slack\/search mode=login/,
  );
});

test('runListChannelsInBrowser は IndexedDB 失敗を次アクション付きエラーへ変換する', async () => {
  const page = {
    async addInitScript(_input: { content: string }) {},
    async goto(_url: string, _options?: unknown) {},
    async waitForTimeout(_ms: number) {},
    async title() {
      return 'Slack';
    },
    url() {
      return 'https://example.slack.com/client/T123';
    },
    async evaluate<T>(arg: string | ((...args: any[]) => T), ..._args: any[]) {
      if (typeof arg === 'string') {
        return undefined as T;
      }
      throw new Error(
        "NotFoundError: Failed to execute 'transaction' on 'IDBDatabase': One of the specified object stores was not found.",
      );
    },
  };

  await assert.rejects(
    () =>
      runListChannelsInBrowser(page, {
        hydrate: false,
        limit: 10,
        workspaceUrl: 'https://example.slack.com',
      }),
    /slack\/search mode=login/,
  );
});

test('runResolveChannelInBrowser は IndexedDB 失敗を次アクション付きエラーへ変換する', async () => {
  const page = {
    async addInitScript(_input: { content: string }) {},
    async goto(_url: string, _options?: unknown) {},
    async waitForTimeout(_ms: number) {},
    async evaluate<T>(arg: string | ((...args: any[]) => T), ..._args: any[]) {
      if (typeof arg === 'string') {
        return undefined as T;
      }
      throw new Error(
        "NotFoundError: Failed to execute 'transaction' on 'IDBDatabase': One of the specified object stores was not found.",
      );
    },
  };

  await assert.rejects(
    () =>
      runResolveChannelInBrowser(page, {
        channelIds: ['C12345678'],
        workspaceUrl: 'https://example.slack.com',
      }),
    /slack\/search mode=login/,
  );
});
