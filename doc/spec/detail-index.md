# Adjutant 詳細仕様インデックス

この文書は、旧統合仕様書に含まれていた論点を、現在どの詳細仕様ファイルで扱うかを示す索引である。

## 分割対象一覧

### 1. 基本仕様

- 目的 / 設計原則 / 実装スコープ
- 想定ファイル
  - `doc/spec/overview.md`
  - `doc/spec/command-reference.md`
  - `doc/spec/design-principles.md`
  - [command-reference.md](/Users/USER/masahide/git/adjutant/doc/spec/command-reference.md)
  - [design-principles.md](/Users/USER/masahide/git/adjutant/doc/spec/design-principles.md)

### 2. 収集ランタイム仕様

- 収集ランタイム実行アーキテクチャ
- Slack 収集仕様
- DOM キャプチャ
- 想定ファイル
  - `doc/spec/collector-runtime.md`
  - [collector-runtime.md](/Users/USER/masahide/git/adjutant/doc/spec/collector-runtime.md)

### 3. データモデル / 保存仕様

- データモデル
- JSONL 保存
- 名称キャッシュ
- raw fetch / CDP 生ログ
- 想定ファイル
  - `doc/spec/data-model.md`
  - `doc/spec/storage.md`
  - [data-model.md](/Users/USER/masahide/git/adjutant/doc/spec/data-model.md)
  - [storage.md](/Users/USER/masahide/git/adjutant/doc/spec/storage.md)

### 4. 設定仕様

- 収集ランタイム設定
- assistant / proactive 設定
- sandbox 設定
- workspace / state 設定
- 想定ファイル
  - `doc/spec/configuration.md`
  - [configuration.md](/Users/USER/masahide/git/adjutant/doc/spec/configuration.md)

### 5. assistant / proactive 仕様

- notification-driven 実行方針
- timeline / watermark / pending flusher
- bootstrap context
- compaction
- memory flush
- hybrid memory search / memory write
- 想定ファイル
  - `doc/spec/assistant-runtime.md`
  - `doc/spec/proactive-routing.md`
  - `doc/spec/memory.md`
  - [assistant-runtime.md](/Users/USER/masahide/git/adjutant/doc/spec/assistant-runtime.md)
  - [proactive-routing.md](/Users/USER/masahide/git/adjutant/doc/spec/proactive-routing.md)
  - [memory.md](/Users/USER/masahide/git/adjutant/doc/spec/memory.md)

### 6. sandbox 仕様

- Docker sandbox 方針
- runSpec
- tool sandbox 化
- hardening
- workspace / home mount 契約
- 想定ファイル
  - `doc/spec/sandbox.md`
  - [sandbox.md](/Users/USER/masahide/git/adjutant/doc/spec/sandbox.md)

### 7. ACP / process 分離仕様

- ACP 分離アーキテクチャ
- worker supervisor
- capability gate
- session recovery
- error classification
- 想定ファイル
  - `doc/spec/acp-architecture.md`
  - [acp-architecture.md](/Users/USER/masahide/git/adjutant/doc/spec/acp-architecture.md)

### 8. API / UI 仕様

- HTTP API
- SSE
- thread / snapshot / activity feed
- Web UI
- 想定ファイル
  - `doc/spec/http-api.md`
  - `doc/spec/ui.md`

## 旧統合仕様書との対応

- 1 章 目的
  - [概要](/Users/USER/masahide/git/adjutant/doc/spec/overview.md)
- 2 章 実装スコープ
  - [概要](/Users/USER/masahide/git/adjutant/doc/spec/overview.md)
  - [機能一覧](/Users/USER/masahide/git/adjutant/doc/spec/feature-catalog.md)
- 3 章 収集ランタイム実行アーキテクチャ
  - [collector-runtime.md](/Users/USER/masahide/git/adjutant/doc/spec/collector-runtime.md)
- 4 章 データモデル
  - [data-model.md](/Users/USER/masahide/git/adjutant/doc/spec/data-model.md)
- 5 章 Slack 収集仕様
  - [collector-runtime.md](/Users/USER/masahide/git/adjutant/doc/spec/collector-runtime.md)
- 6 章 DOM キャプチャ
  - [collector-runtime.md](/Users/USER/masahide/git/adjutant/doc/spec/collector-runtime.md)
- 7 章 保存仕様
  - [storage.md](/Users/USER/masahide/git/adjutant/doc/spec/storage.md)
- 8 章 設定
  - [configuration.md](/Users/USER/masahide/git/adjutant/doc/spec/configuration.md)
- 9 章 実行コマンド
  - [command-reference.md](/Users/USER/masahide/git/adjutant/doc/spec/command-reference.md)
- 10 章 既知の制約
  - [design-principles.md](/Users/USER/masahide/git/adjutant/doc/spec/design-principles.md)
- 11 章 ロードマップ（設計メモ）
  - [design-principles.md](/Users/USER/masahide/git/adjutant/doc/spec/design-principles.md)
- 12 章 ファイルファースト保存原則（設計）
  - [design-principles.md](/Users/USER/masahide/git/adjutant/doc/spec/design-principles.md)
- 13 章 Assistant / Proactive 実装仕様
  - [assistant-runtime.md](/Users/USER/masahide/git/adjutant/doc/spec/assistant-runtime.md)
  - [proactive-routing.md](/Users/USER/masahide/git/adjutant/doc/spec/proactive-routing.md)
  - [memory.md](/Users/USER/masahide/git/adjutant/doc/spec/memory.md)
  - [sandbox.md](/Users/USER/masahide/git/adjutant/doc/spec/sandbox.md)
- 14 章 ACP 分離アーキテクチャ
  - [acp-architecture.md](/Users/USER/masahide/git/adjutant/doc/spec/acp-architecture.md)

## 次の分割優先順

1. `collector-runtime.md`
2. `data-model.md`
3. `storage.md`
4. `configuration.md`
5. `assistant-runtime.md`
6. `sandbox.md`
7. `acp-architecture.md`
