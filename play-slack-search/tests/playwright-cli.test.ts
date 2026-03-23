import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import {
  parseRunCodeJsonOutput,
  runPlaywrightInteractive,
  serializeBrowserCode,
} from '../scripts/slack-search/playwright-cli.ts';
import { runSlackSearchInBrowser } from '../scripts/slack-search/browser/search.ts';

test('parseRunCodeJsonOutput は ### Result ブロックから JSON を取り出す', () => {
  const payload = parseRunCodeJsonOutput<{ ok: boolean }>(
    '### Result\n{"ok":true}\n',
  );
  assert.deepEqual(payload, { ok: true });
});

test('parseRunCodeJsonOutput は後続セクションがあっても最初の結果を使う', () => {
  const payload = parseRunCodeJsonOutput<{ ok: boolean }>(
    '### Result\n{"ok":true}\n### Logs\nverbose',
  );
  assert.deepEqual(payload, { ok: true });
});

test('parseRunCodeJsonOutput は ### Error を例外へ変換する', () => {
  assert.throws(
    () => parseRunCodeJsonOutput('### Error\nTimeoutError: boom\nstack trace'),
    /TimeoutError: boom/,
  );
});

test('parseRunCodeJsonOutput は未知フォーマットを拒否する', () => {
  assert.throws(
    () => parseRunCodeJsonOutput('plain output only'),
    /Could not find JSON result in playwright-cli output/,
  );
});

test('serializeBrowserCode は入力値を埋め込んだ関数文字列を返す', () => {
  async function runner(_page: unknown, input: { value: number }) {
    return input.value;
  }

  const source = serializeBrowserCode(runner, { value: 7 });

  assert.match(source, /^async page => /);
  assert.match(source, /"value":7/);
  assert.match(source, /input/);
});

test('serializeBrowserCode は TS 変換由来の __name helper を shim する', () => {
  const source = serializeBrowserCode(runSlackSearchInBrowser, {
    limit: 1,
    query: 'test',
    workspaceUrl: 'https://example.slack.com',
  });

  assert.match(source, /const __name = \(target, _name\) => target;/);
  const runner = new Function(`return (${source});`)() as (
    page: Record<string, unknown>,
  ) => Promise<unknown>;

  assert.equal(typeof runner, 'function');
});

test('serializeBrowserCode は require 経由で import_runtime_shims 参照が入っても解決できる', () => {
  const require = createRequire(import.meta.url);
  const { runListUsersInBrowser } = require(
    '../scripts/slack-search/browser/list-users.ts',
  ) as {
    runListUsersInBrowser: (
      page: unknown,
      input: { hydrate: boolean; limit: number; workspaceUrl: string },
    ) => Promise<unknown>;
  };

  const source = serializeBrowserCode(runListUsersInBrowser, {
    hydrate: false,
    limit: 1,
    workspaceUrl: 'https://example.slack.com/client/T123',
  });

  assert.match(
    source,
    /const import_runtime_shims = \{ installBrowserRuntimeShims, buildSlackClientStateUnavailableError \};/,
  );
  const runner = new Function(`return (${source});`)() as (
    page: Record<string, unknown>,
  ) => Promise<unknown>;

  assert.equal(typeof runner, 'function');
});

test('runPlaywrightInteractive が export されている', () => {
  assert.equal(typeof runPlaywrightInteractive, 'function');
});
