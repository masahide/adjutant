# Phase B 即時ロールバック Runbook

## 目的

Phase B（memory / sandbox / summary batch）起因の障害発生時に、数分以内で安全側へ切り戻す。

## 事前条件

- control-plane を環境変数で再起動できること
- 障害検知時に runId / sessionKey を確認できること（`run/failed` SSE または control-plane 構造化ログ）

## 即時ロールバック手順

1. Phase B 機能を main 限定へ縮退  
   `ADJUTANT_PHASE_B_ROLLOUT_SCOPE=main`
2. summary batch を停止  
   `ADJUTANT_MARKDOWN_SUMMARY_BATCH_ENABLED=0`
3. sandbox を停止（必要時）  
   `ADJUTANT_SANDBOX_MODE=off`
4. memory write を停止（必要時、worker 側設定）  
   `memoryWriteEnabled=false` の運用設定へ戻す
5. control-plane を再起動し、以下を確認
   - `GET /api/snapshot` が 200
   - `POST /api/commands` が 202
   - `run/failed` が急増していない

## 追加の縮退

- session/load 起因の障害時は  
  `ACP_ENABLE_LOAD_SESSION=0` を設定し `session/new` 固定運用へ切り替える

## 復旧判定

- 連続 30 分で `run/failed` 比率が平常レンジに戻る
- `session.new_fallback` が意図しない頻度で増加していない
- `summary_batch.failed` ログが 0（無効化時）または許容範囲（再有効化時）

## 再展開手順

1. `ADJUTANT_MARKDOWN_SUMMARY_BATCH_ENABLED=1`（main のみ）
2. エラー率監視（最低 30 分）
3. `ADJUTANT_PHASE_B_ROLLOUT_SCOPE=all` に拡張
4. spoke の run 成功率と tool エラー率を監視
