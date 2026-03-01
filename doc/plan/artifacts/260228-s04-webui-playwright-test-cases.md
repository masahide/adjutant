# 260228-s04 WebUI Playwright Test Cases

## 対象

- URL: `http://127.0.0.1:3110/`
- サーバー起動条件
  - `ADJUTANT_CONTROL_PLANE_PORT=3110`
  - `ADJUTANT_TEST_MOCK_RUNNER=1`
  - `ADJUTANT_TEST_MOCK_DELTA=mock-stream-chunk`
  - `ADJUTANT_TEST_MOCK_TEXT=mock-final-text`
  - `ADJUTANT_TEST_FAKE_TOOL_CALLS=1`

## テスト項目

1. TC-WUI-001: 初期表示

- 手順
  - WebUI を開く
- 期待結果
  - タイトル `Adjutant Control Plane`
  - 見出し `Adjutant Web UI (co-located)`
  - `sessionKey`, `message`, `Send` が表示される
- 結果: `pass`
- 証跡
  - `doc/plan/artifacts/260228-s04-webui-initial-snapshot.yml`
  - `doc/plan/artifacts/260228-s04-webui-playwright-run.log` (`## open`, `## title`)

2. TC-WUI-002: 送信で accepted/update/completed が表示

- 手順
  - `sessionKey=main`, `message=playwright hello` で送信
- 期待結果
  - `log` に `[accepted]`, `[run/update]`, `[run/completed]` が追記される
- 結果: `pass`
- 証跡
  - `doc/plan/artifacts/260228-s04-webui-playwright-run.log` (`## log-after-submit-1`)

3. TC-WUI-003: ツール通知（tool_call/tool_call_update）表示

- 手順
  - fake tool call 有効状態で送信
- 期待結果
  - `log` に `"sessionUpdate":"tool_call"` と `"sessionUpdate":"tool_call_update"` が含まれる
- 結果: `pass`
- 証跡
  - `doc/plan/artifacts/260228-s04-webui-playwright-run.log` (`## log-toolcall`)

4. TC-WUI-004: リロード後に再送できる

- 手順
  - ページを reload
  - 再度 message を送信
- 期待結果
  - 送信後に `[accepted]` と `[run/completed]` が追記される
- 結果: `pass`
- 証跡
  - `doc/plan/artifacts/260228-s04-webui-reload-snapshot.yml`
  - `doc/plan/artifacts/260228-s04-webui-playwright-run.log` (`## log-after-submit-2`)

## 実行メモ

- 実行ツール: `playwright-cli`
- 証跡: `doc/plan/artifacts/260228-s04-webui-playwright-run.log`
- 既知事項: Console error は `GET /favicon.ico 404` のみ（機能影響なし）
