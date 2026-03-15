# Adjutant 概要

## 何をするシステムか

Adjutant は、Slack Desktop の CDP イベントを収集し、後段で再利用しやすい形で保存する収集基盤と、その保存済みデータや補助ツールを使って動く AI アシスタント基盤を合わせ持つシステムである。

現行の標準起動は `pnpm start` で、control-plane を中心に以下を提供する。

- Slack 関連イベントの収集・処理
- プロアクティブ通知ルーティング
- Heartbeat
- AI エージェント実行
- memory search / memory write
- Web UI と HTTP / SSE API

## 主目的

- 後段で再利用しやすいイベント基盤を整備する
- ファイルファーストの AI アシスタント基盤を整備する
- 収集、通知判断、エージェント実行、監査を一貫して扱えるようにする

## 設計原則

- File First
  - 永続データの正本はファイルとして保存する
- JSONL First
  - イベントやメッセージ系の正本は JSONL とする
- Markdown First
  - エージェント記憶の正本は Markdown とする
- Index Is Secondary
  - SQLite は検索性能のための補助インデックスとして扱い、正本にしない
- Recoverability
  - 障害時は正本ファイルから再構築できることを優先する

## 現行アーキテクチャの要点

- 収集、制御、エージェント実行を分離した ACP / Process RPC ベース構成を採る
- control-plane は API、UI、通知ルーティング、worker 管理、監査の中心になる
- agent worker は ACP stdio server として動作し、`pi-coding-agent` と custom tools を仲介する
- sandbox は Docker を使って `bash` および標準ツール群の実行境界を制御する
- custom tool は direct 公開せず、`tool_hub` 経由の provider / action 契約へ統一する

## 実装スコープの大枠

- 実装済み
  - ACP worker / supervisor
  - control-plane HTTP / SSE API
  - Web UI
  - session recovery
  - tool event bridge
  - proactive routing
  - heartbeat
  - tool hub
  - memory search / write
  - sandbox
  - workspace bootstrap
- 一部のみ実装
  - 保存基盤の一部設計
  - summary batch
  - durable queue まわりの一部運用補強
- 未実装
  - GitHub / git-local 収集
  - 一部 routing policy の本適用
  - 通知キューの完全永続化
  - 一部 run 制御 API

## 参照先

- [全体像](/Users/USER/masahide/git/adjutant/doc/spec/system-overview.md)
- [機能一覧](/Users/USER/masahide/git/adjutant/doc/spec/feature-catalog.md)
- [詳細仕様インデックス](/Users/USER/masahide/git/adjutant/doc/spec/detail-index.md)
