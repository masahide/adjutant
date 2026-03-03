# 260302-s01 Tool I/O Collapsible Playwright 検証レポート

実施日時: 2026-03-02

## 実行環境

- URL: `http://127.0.0.1:3110/`
- サーバー起動:
  - `ADJUTANT_CONTROL_PLANE_HOST=127.0.0.1`
  - `ADJUTANT_CONTROL_PLANE_PORT=3110`
  - `ADJUTANT_TEST_FAKE_TOOL_CALLS=1`

## 手順

1. `playwright-cli open http://127.0.0.1:3110/`
2. Composer の `Message input` に `show tool io` を入力して送信
3. 返信内の `Used tool: tool` をクリックして展開
4. `playwright-cli snapshot --filename doc/plan/artifacts/260302-s01-tool-io-collapsible.yml`

## 結果

- `Used tool: tool` が折りたたみ表示されることを確認
- 展開後に以下を確認
  - args: `{ "prompt": "show tool io" }`
  - result: `{ "ok": true }`
- 証跡:
  - `doc/plan/artifacts/260302-s01-tool-io-collapsible.yml`
