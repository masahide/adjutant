import assert from 'node:assert/strict';
import test from 'node:test';

import {
  installBrowserRuntimeShims,
  NAME_HELPER_SHIM_SOURCE,
} from '../scripts/slack-search/browser/runtime-shims.ts';

test('installBrowserRuntimeShims は __name shim を現在ページと以後の navigate に注入する', async () => {
  const calls: Array<{ method: string; value: unknown }> = [];
  const page = {
    addInitScript: async ({ content }: { content: string }) => {
      calls.push({ method: 'addInitScript', value: content });
    },
    evaluate: async (source: string) => {
      calls.push({ method: 'evaluate', value: source });
    },
  };

  await installBrowserRuntimeShims(page);

  assert.deepEqual(calls, [
    { method: 'addInitScript', value: NAME_HELPER_SHIM_SOURCE },
    { method: 'evaluate', value: NAME_HELPER_SHIM_SOURCE },
  ]);
});

test('installBrowserRuntimeShims は現在ページ注入失敗を無視する', async () => {
  const page = {
    addInitScript: async (_input: { content: string }) => undefined,
    evaluate: async (_source: string) => {
      throw new Error('page closed');
    },
  };

  await assert.doesNotReject(async () => {
    await installBrowserRuntimeShims(page);
  });
});
