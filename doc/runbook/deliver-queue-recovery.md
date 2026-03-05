# Deliver Queue Recovery Runbook

## 1. 目的

`deliver/enqueue` 受理後に `deliver/completed` が返らない、または deliver 子プロセスが異常終了した場合に、queue/cursor の整合性を保ったまま復旧する。

## 2. 監視対象

- プロセスログ
  - `deliver_supervisor.log`
  - `deliver.enqueue.accepted`
  - `deliver.completed.received`
- 永続化ファイル
  - `state/journal/control-plane/deliver-queue.jsonl`
  - `state/cursor/control-plane.deliver-queue.json`
  - `state/cursor/control-plane.deliver-completion.snapshot.json`

## 3. 異常の典型パターン

- `DELIVER_TIMEOUT` が連続発生し、`deliver.enqueue.accepted` の `dispatchStatus=failed` が増加する
- `DELIVER_CRASHED` が断続的に発生し、`restartCount` が上昇し続ける
- `deliver.completed.received` が出ず、`control-plane.deliver-queue` cursor が進まない

## 4. 一次対応手順

1. `deliver_supervisor.log` で `DELIVER_CRASHED` / `DELIVER_STDIN_ERROR` / `DELIVER_RPC_TIMEOUT` を確認する。
2. `state/cursor/control-plane.deliver-queue.json` の offset が停滞しているか確認する。
3. `state/journal/control-plane/deliver-queue.jsonl` に未完了の enqueue が残っているか確認する。
4. `deliver-slack` 側設定（`ADJUTANT_DELIVER_SLACK_ENTRY`, timeout 関連 env）を確認し、必要なら `control-plane` を再起動する。
5. 再起動後、未完了 enqueue の replay により `deliver.completed.received` が再開し cursor が進むことを確認する。
6. 同一 `messageId` completion の重複通知があっても `completed` が最終状態として維持されることを確認する。

## 5. 復旧確認チェック

- `deliver.completed.received` の `cursorCommitted=true` が出力される
- `state/cursor/control-plane.deliver-queue.json` の offset が replay 前より増加する
- 同一 `messageId` で最終状態が `completed` のまま不変である

## 6. エスカレーション

- 30 分以上 cursor が進まない場合、deliver retry/backoff 設定と外部 Slack API 障害を含めて運用チームへエスカレーションする。
- 24 時間以内に `DELIVER_CRASHED` が 3 回以上再発した場合、`deliver-slack` 実装と supervisor 設定（`maxRestarts`, `restartDelayMs`）の見直しを実施する。
