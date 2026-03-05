# Proactive Flusher Operations Runbook

## 1. 目的

`pending flusher` が stale session を再回収できない、または過剰に回収する障害を検知し、`timeline/watermarks` の整合を保ったまま復旧する。

## 2. 監視指標

- `flusher_tick_duration_ms`
  - 1 tick の実行時間
- `flusher_enqueued_sessions`
  - tick あたり enqueue された session 数
- `flusher_suppressed_sessions`
  - 別人返信 suppression で抑制した session 数
- `watermark_scan_lag_bytes`
  - `timeline.jsonl` 末尾オフセットとの差分

## 3. アラートしきい値（初期値）

- warning
  - `flusher_tick_duration_ms >= 10000` が 5 分継続
  - または `watermark_scan_lag_bytes >= 1_000_000`
- critical
  - 連続 3 tick で `flusher_enqueued_sessions=0` かつ stale session が存在
  - または watermark load/save 失敗が連続 3 回

## 4. 一次対応

1. control-plane ログで `TIMELINE_APPEND_FAILED` / `WATERMARK_SAVE_FAILED` の有無を確認する。
2. `timeline.jsonl` の末尾破損・truncate の有無を確認する。
3. `watermarks.json` の `scan.lastScannedOffset` がファイルサイズを超えていないか確認する。
4. 破損が疑われる場合、バックアップ退避後に flusher recovery を実行して offset を再初期化する。
5. 復旧後、次 tick で `flusher_enqueued_sessions` が回復し、過剰 enqueue が発生しないことを確認する。

## 5. エスカレーション

- 30 分以内に lag が回復しない場合、Phase E の timeline scan 実装改善を優先エスカレーションする。
- 24 時間以内に同一障害が 3 回再発した場合、timeline compact/rotation 戦略の見直しを行う。
