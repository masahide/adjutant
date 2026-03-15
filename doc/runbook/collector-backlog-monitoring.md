# Collector Backlog Monitoring Runbook

## 1. 目的

`collector/ingest` 受理後に terminal 未確定の backlog を監視し、取りこぼしや停滞を早期検知して復旧する。

## 1.1 仕様参照

- `doc/spec/storage.md`（Journal / Cursor 保存先）
- `doc/spec/acp-architecture.md`（境界契約とエラー分類）
- 主対象永続化:
  - `state/journal/control-plane/inbox.jsonl`
  - `state/cursor/control-plane.inbox.json`

## 2. 指標定義

- `ingest_backlog_count`
  - 定義: control-plane journal に受理済みで `completed|failed|cancelled` 未確定の件数
- `oldest_ingest_age_seconds`
  - 定義: 最古の未確定 ingest が受理されてからの経過秒

## 3. しきい値

- warning
  - `ingest_backlog_count >= 100`
  - または `oldest_ingest_age_seconds >= 60`
- critical
  - `ingest_backlog_count >= 500`
  - または `oldest_ingest_age_seconds >= 300`

## 4. アラート条件

- warning
  - warning 条件が連続 5 分継続した場合に通知
- critical
  - critical 条件を検知した時点で即時通知
- resolve
  - warning 条件未満に復帰した状態が 10 分継続したら解除

## 5. 一次対応手順

1. `control-plane` のログで `WORKER_TIMEOUT` / `WORKER_CRASHED` / `ACP_PROTOCOL_ERROR` の有無を確認する。
2. `collector-slack` のログで CDP 再接続ループや `collector/ingest` timeout の有無を確認する。
3. `state/cursor/control-plane.inbox.json` の `committedSeq` が停滞していないか確認する。
4. backlog が増え続ける場合、`collector-slack` を一時停止して新規 ingest を止める。
5. worker のヘルスを確認し、必要に応じて `control-plane` を再起動して journal replay で再処理する。
6. 復旧後、同一 `dedupeKey` の再送が `INVALID_REQUEST` ではなく冪等受理されることを確認する。

## 6. エスカレーション

- 30 分以内に critical が解消しない場合、Phase D の queue/recovery 拡張タスクへ優先エスカレーションする。
- 同一障害が 24 時間以内に 3 回以上再発した場合、`sessionKey` 投影と prompt 投影ロジックの見直しを実施する。
