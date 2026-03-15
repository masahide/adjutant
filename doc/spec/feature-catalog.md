# Adjutant 機能一覧

## 1. 収集機能

- Slack CDP 接続
- Fetch interception
- WebSocket frame 解釈
- Response hook による補完
- DOM capture
- イベント正規化
- JSONL append 保存
- 名前解決キャッシュ
- 任意の raw log 保存

## 2. Control-Plane 機能

- HTTP API
- SSE event stream
- run lifecycle 管理
- session / thread 管理
- idempotency 管理
- audit log
- pending permission 管理
- recovery store / journal replay

## 3. Assistant 実行機能

- agent runner
- session recovery
- bootstrap context 注入
- workspace bootstrap
- pre-compaction memory flush
- context compaction
- heartbeat

## 4. Tooling 機能

- `tool_hub`
  - `slack/search`
  - `memory/search`
  - `memory/get`
  - `memory/write`
- sandboxed `bash`
- sandboxed file tools
  - `read`
  - `edit`
  - `write`
  - `grep`
  - `find`
  - `ls`

## 5. Memory / Knowledge 機能

- Markdown memory files
- daily memory
- long-term memory
- SQLite hybrid search index
- summary batch

## 6. Proactive 機能

- rule triage
- attention window
- batch classifier
- global concurrency queue
- pending flusher
- watermark store

## 7. UI / 観測機能

- co-located assistant Web UI
- audit detail 表示
- activity feed
- tool event 表示
- thread 一覧 / archive

## 8. プロセス分離 / 実行基盤機能

- ACP stdio worker
- worker supervisor
- process RPC collector supervisor
- process RPC deliver supervisor
- capability gate

## 9. 主要設定カテゴリ

- 収集ランタイム設定
- assistant / proactive 設定
- sandbox 設定
- workspace / state 設定
- HTTP / UI 設定
- heartbeat 設定

## 10. 実装状態の大分類

### 実装済み

- control-plane
- ACP worker
- Web UI
- tool hub
- sandbox
- memory search / write
- workspace bootstrap
- heartbeat
- summary batch の基本実装

### 一部実装 / 運用中

- proactive routing の一部高度化
- recovery / durable queue の一部運用補強
- summary batch の周辺運用

### 未実装

- GitHub / git-local 収集
- routing policy の完全適用
- 通知キューの完全永続化
- 一部 run 制御 API

## 11. 詳細仕様への対応づけ

- 収集
  - 収集ランタイム仕様
  - Slack 収集仕様
  - DOM キャプチャ仕様
- 保存
  - データモデル仕様
  - 保存仕様
- assistant
  - assistant / proactive 仕様
  - memory 仕様
  - heartbeat 仕様
- 実行基盤
  - sandbox 仕様
  - ACP 仕様
  - API / UI 仕様
