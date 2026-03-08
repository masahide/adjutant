import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseRunCodeJsonOutput,
  serializeBrowserCode,
} from '../scripts/slack-search/playwright-cli.ts';

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
