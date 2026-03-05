# Heartbeat Operations Runbook

## 1. 目的

定期 heartbeat と手動 heartbeat（`POST /api/heartbeat/run`）の失敗検知、復旧、通知品質の維持を行う。

## 1.1 仕様参照

- `doc/spec.md` 13.3（control-plane 責務: heartbeat）
- `doc/spec.md` 14.5（ACP / Process RPC 境界契約）
- `doc/spec.md` 14.8（エラー分類と回復）
- 主対象永続化:
  - `state/heartbeat-runs.jsonl`

## 2. 監視対象

- `heartbeat_runs_total{status}`
  - `ran|skipped|failed` 件数
- `heartbeat_needs_attention_total`
  - `report_heartbeat_status(status=needs_attention)` の件数
- `heartbeat_notify_total`
  - `notify=true` 通知件数
- `heartbeat_tool_contract_violation_total`
  - tool 未呼び出し、複数呼び出し、payload 不正

## 3. しきい値（初期値）

- warning
  - 連続 3 回 `failed`
  - または 30 分 `ran=0`
- critical
  - 連続 5 回 `failed`
  - または `heartbeat_tool_contract_violation_total` が 1 時間で 3 回以上

## 4. 一次対応

1. control-plane ログで `HEARTBEAT_FAILED` と原因（timeout/tool contract）を確認する。
2. `heartbeat-runs.jsonl` の追記停止・破損を確認する。
3. `POST /api/heartbeat/run` を手動実行し、`GET /api/heartbeat/last` で結果を確認する。
4. tool 契約違反が出る場合は `HEARTBEAT.md` の `report_heartbeat_status` 呼び出し条件を確認する。
5. API は成功だが通知欠落がある場合、SSE `event: heartbeat` 配信ログを確認する。

## 5. エスカレーション

- 15 分以内に手動実行が成功しない場合、worker 側セッション実行と timeout 設定を含めてエスカレーションする。
- 誤通知（false positive/false negative）が多発する場合、classifier/heartbeat prompt の見直しタスクを起票する。
