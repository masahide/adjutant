# Proactive Routing 仕様

## 1. 目的

この文書は、control-plane が notification / self activity をどう取り込み、timeline / watermark / flusher / heartbeat をどう扱うかを定義する。

## 2. スコープ

### 含むもの

- collector からの `collector/ingest`
- notification-driven 判定
- timeline / watermark
- pending flusher
- heartbeat 実行と履歴
- activity feed への投影

### 含まないもの

- agent 実行内部の詳細
  - [assistant-runtime.md](/Users/USER/masahide/git/adjutant/doc/spec/assistant-runtime.md)
- worker / ACP 境界
  - [acp-architecture.md](/Users/USER/masahide/git/adjutant/doc/spec/acp-architecture.md)

## 3. 主要コンポーネント

- `src/index.ts`
- `src/control-plane/proactive/ingress-service.ts`
- `src/control-plane/proactive/timeline-store.ts`
- `src/control-plane/proactive/watermark-store.ts`
- `src/control-plane/notification-decision.ts`
- `src/control-plane/http/activity-feed.ts`
- `src/control-plane/heartbeat/heartbeat-runner.ts`
- `src/control-plane/heartbeat/result-store.ts`

## 4. Notification-Driven 方針

現行標準経路では、collector から流入した Slack event をそのまま durable queue の再生対象にはしない。必要な文脈は run 時に `tool_hub(provider=slack, action=search)` で取得する。

大枠の扱い:

- direct mention notification
  - AI run 対象
- self post / self reaction
  - 記録対象
- direct mention でない notification
  - `no_action` または `needs_review` 側へ倒す

## 5. Timeline / Watermark

### 5.1 timeline

`TimelineStore` は `<stateDir>/timeline.jsonl` に append-only で記録する。

主レコード:

- `recordType=event`
- `recordType=action`

`actionType` は主に次を使う。

- `assistant_final`
- `assistant_aborted`
- `assistant_error`

### 5.2 watermark

`WatermarkStore` は `<stateDir>/watermarks.json` に次を保持する。

- scan offset
- session ごとの handled offset
- open post count
- `oldestOpenAt`
- `oldestActor`

`assistant_final` のみ handled 境界を前進させる。`aborted` / `error` は handled を進めない。

## 6. Pending Flusher

flusher は timeline を差分走査して session ごとの open 状態を更新する。

主要設定:

- `ADJUTANT_FLUSHER_ENABLED`
- `ADJUTANT_FLUSHER_INTERVAL_MS`
- `ADJUTANT_FLUSHER_STALE_MS`

現行契約:

- stale open post を検出する
- 別 actor の返信がある session は suppress できる
- scan 終了後に `lastGoodOffset` を更新する

## 7. Heartbeat

heartbeat は `main` session 上の full agent turn として動く。

主要設定:

- `ADJUTANT_HEARTBEAT_ENABLED`
- `ADJUTANT_HEARTBEAT_INTERVAL_MS`
- `ADJUTANT_HEARTBEAT_TIMEOUT_MS`
- `ADJUTANT_HEARTBEAT_FILE_PATH`

実行モデル:

- prompt は `HEARTBEAT.md` を優先して読む
- main session が busy なら skip する
- 結果は `<stateDir>/heartbeat-runs.jsonl` に保存する
- `HEARTBEAT_OK` 相当は UI でノイズ扱いできる

## 8. Activity Feed

`NotificationDecision` は現在の UI 用に次へ正規化される。

- `no_action`
- `draft_reply`
- `needs_review`

`GET /api/activity-feed` は newest-first の lightweight view を返す。v1 では既読状態を持たない。

## 9. 実装対応

- `src/index.ts`
- `src/control-plane/proactive/ingress-service.ts`
- `src/control-plane/proactive/timeline-store.ts`
- `src/control-plane/proactive/watermark-store.ts`
- `src/control-plane/notification-decision.ts`
- `src/control-plane/http/activity-feed.ts`
- `src/control-plane/heartbeat/heartbeat-runner.ts`
- `src/control-plane/heartbeat/result-store.ts`

## 10. 関連文書

- [assistant runtime 仕様](/Users/USER/masahide/git/adjutant/doc/spec/assistant-runtime.md)
- [ACP 分離アーキテクチャ](/Users/USER/masahide/git/adjutant/doc/spec/acp-architecture.md)
