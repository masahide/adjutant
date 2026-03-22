# 保存仕様

## 1. 目的

この文書は、Adjutant の現行 `src/` 実装がどこに何を保存するかを定義する。

## 2. スコープ

### 含むもの

- `stateDir` / `workspaceDir` / `dataDir` の役割
- control-plane / worker / collector が生成する永続ファイル
- append-only journal と snapshot / cursor の使い分け
- workspace 上の bootstrap / memory ファイル

### 含まないもの

- イベント payload の詳細構造
  - [data-model.md](/Users/USER/masahide/git/adjutant/doc/spec/data-model.md)
- 環境変数の完全一覧
  - [configuration.md](/Users/USER/masahide/git/adjutant/doc/spec/configuration.md)

## 3. 保存ディレクトリ

### 3.1 `stateDir`

`stateDir` は control-plane / worker の永続状態を置く基準ディレクトリである。

- 既定値: `~/.adjutant`
- 上書き: `ADJUTANT_STATE_DIR`

主な配下:

- `timeline.jsonl`
- `watermarks.json`
- `heartbeat-runs.jsonl`
- `audit/agent-audit.ndjson`
- `guardrails/policies.json`
- `guardrails/audit.jsonl`
- `journal/control-plane/*.jsonl`
- `cursor/*.json`
- `worker/session-store.json`
- `worker/sessions.json`
- `pi-sessions/*.jsonl`
- `memory/main.sqlite`
- `agents/main/transcripts/`
- `agents/main/summary-batch-watermark.json`

### 3.2 `workspaceDir`

`workspaceDir` は agent の作業ディレクトリであり、bootstrap context と long-term memory の正本を置く。

- 既定値: `<stateDir>/workspace`
- 上書き: `ADJUTANT_WORKSPACE_DIR`

主な配下:

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `HEARTBEAT.md`
- `BOOTSTRAP.md`
- `MEMORY.md`
- `memory/YYYY-MM-DD.md`

### 3.3 `dataDir`

`dataDir` は collector 系の保存先であり、Slack 自己アクティビティや将来の収集データを置く。

- 既定値: `<stateDir>/data`
- 上書き: `ADJUTANT_DATA_DIR`
- 旧互換 alias: `DATA_DIR`

## 4. 現行の主要ファイル

### 4.1 Timeline / Watermark

- `<stateDir>/timeline.jsonl`
  - proactive 判定と terminal action の append-only timeline
  - `TimelineStore.fromStateDir()` が利用する
- `<stateDir>/watermarks.json`
  - flusher の scan 進捗と session ごとの handled / open 状態
  - `WatermarkStore.fromStateDir()` が利用する

### 4.2 Heartbeat / Audit / Guardrail

- `<stateDir>/heartbeat-runs.jsonl`
  - heartbeat 実行結果の履歴
- `<stateDir>/audit/agent-audit.ndjson`
  - agent run / tool call / summary batch の監査ログ
  - `ADJUTANT_AGENT_AUDIT_LOG_PATH` で変更可能
- `<stateDir>/guardrails/audit.jsonl`
  - guardrail の `allow / review / forbid` 判定ログ
  - `audit` モードでも append される
- `<stateDir>/guardrails/policies.json`
  - `allow_always` / `reject_always` による保存済み policy
  - `workspace` scope では `scopeKey=projectRoot:<abs-path>::workspaceDir:<abs-path>` を持つ

### 4.3 Worker 永続状態

- `<stateDir>/worker/session-store.json`
  - ACP worker の session store
  - 現行スキーマでは `cwd` フィールド名を使うが、意味は workspace path である
- `<stateDir>/worker/sessions.json`
  - compaction metadata の保存先
  - `compactionCount`, `memoryFlushAt`, `contextTokens` などを保持する
- `<stateDir>/pi-sessions/<sessionId>.jsonl`
  - `pi-coding-agent` の session manager が使う transcript / tool history 保存先

### 4.4 Session / Thread / Queue Journal

control-plane の durable state は append-only journal と cursor / snapshot を組み合わせて保持する。

- `<stateDir>/journal/control-plane/inbox.jsonl`
- `<stateDir>/cursor/control-plane.inbox.json`
- `<stateDir>/journal/control-plane/deliver-queue.jsonl`
- `<stateDir>/cursor/control-plane.deliver-queue.json`
- `<stateDir>/journal/control-plane/session-recovery.jsonl`
- `<stateDir>/cursor/control-plane.session-recovery.replay-cursor.json`
- `<stateDir>/cursor/control-plane.session-recovery.snapshot.json`
- `<stateDir>/journal/control-plane/threads.jsonl`
- `<stateDir>/cursor/control-plane.threads.replay-cursor.json`
- `<stateDir>/cursor/control-plane.threads.snapshot.json`
- `<stateDir>/journal/control-plane/idempotency.jsonl`
- `<stateDir>/cursor/control-plane.idempotency.snapshot.json`
- `<stateDir>/journal/control-plane/chat-history/YYYY-MM-DD.jsonl`
  - legacy fallback path は `chat-history.jsonl`

### 4.5 Summary Batch / Memory Search

- `<stateDir>/agents/main/transcripts/`
  - summary batch が読む transcript 群
  - `ADJUTANT_SESSION_TRANSCRIPTS_DIR` で変更可能
- `<stateDir>/agents/main/summary-batch-watermark.json`
  - summary batch の処理 watermark
  - `ADJUTANT_SUMMARY_BATCH_WATERMARK_PATH` で変更可能
- `<stateDir>/memory/main.sqlite`
  - memory search 用 SQLite index
  - `ADJUTANT_MEMORY_SEARCH_DB_PATH` で変更可能

### 4.6 Collector の自己アクティビティ

- `<dataDir>/state/activity/self/YYYY-MM-DD.jsonl`
  - collector が self post / self reaction を append する
  - 現行標準経路では `post` / `reaction` はここへ保存され、`notification` のみ条件付きで control-plane に送られる

## 5. Workspace 上のファイル

### 5.1 Bootstrap seed

workspace 初期化では `assistant/prompts` から seed する。これらは `vendor/openclaw/docs/reference/templates` の取り込み元を repo 管理下へ複製したものとする。

- 常時 seed 対象
  - `AGENTS.md`
  - `SOUL.md`
  - `TOOLS.md`
  - `IDENTITY.md`
  - `USER.md`
  - `HEARTBEAT.md`
- brand-new workspace のときのみ seed
  - `BOOTSTRAP.md`

### 5.2 Memory の正本

- `MEMORY.md`
  - long-term memory の正本
- `memory/YYYY-MM-DD.md`
  - daily summary / daily memory の追記先

`memory_search` はこれら Markdown を source of truth とし、SQLite は派生 index として扱う。

## 6. 書き込み方式

### 6.1 Append-only が基本

次のファイルは append-only を前提にしている。

- `timeline.jsonl`
- `heartbeat-runs.jsonl`
- `agent-audit.ndjson`
- `journal/control-plane/*.jsonl`
- `chat-history/*.jsonl`
- `dataDir/state/activity/self/*.jsonl`

### 6.2 Snapshot / Cursor は置換保存

次のファイルは現在値の snapshot / cursor として上書き保存する。

- `watermarks.json`
- `cursor/*.json`
- `worker/session-store.json`
- `worker/sessions.json`
- `agents/main/summary-batch-watermark.json`

## 7. Legacy / 非標準経路

`JsonlWriter` が使う次の出力形式は、legacy 由来の実装であり、現行標準の collector 経路では正本として使っていない。

```text
<dataDir>/accounts/<account_id>/YYYY/MM/DD/<source>/events.jsonl
```

同様に、team ごとの名称キャッシュや raw fetch / CDP debug log も `src/` 標準ランタイムでは未接続である。必要なら legacy / script 用の補助仕様として別文書へ分離する。

## 8. 実装対応

- `src/runtime/runtime-directories.ts`
- `src/control-plane/proactive/timeline-store.ts`
- `src/control-plane/proactive/watermark-store.ts`
- `src/control-plane/heartbeat/result-store.ts`
- `src/control-plane/audit/agent-audit-log.ts`
- `src/guardrails/policy-store.ts`
- `src/guardrails/audit-log.ts`
- `src/control-plane/acp/session-recovery-store.ts`
- `src/control-plane/process-rpc/ingest-inbox-store.ts`
- `src/control-plane/process-rpc/deliver-queue-store.ts`
- `src/control-plane/http/thread-repository.ts`
- `src/control-plane/idempotency-store.ts`
- `src/control-plane/http/chat-history-store.ts`
- `src/agent-worker-acp/session-store.ts`
- `src/assistant/agent-session-factory.ts`
- `src/assistant/session-compaction-store.ts`
- `src/assistant/markdown-summary-batch.ts`
- `src/assistant/memory/config.ts`
- `src/assistant/workspace-bootstrap.ts`
- `src/assistant/memory/writer.ts`
- `src/collector-slack/self-activity-store.ts`

## 9. 関連文書

- [概要](/Users/USER/masahide/git/adjutant/doc/spec/overview.md)
- [全体像](/Users/USER/masahide/git/adjutant/doc/spec/system-overview.md)
- [データモデル仕様](/Users/USER/masahide/git/adjutant/doc/spec/data-model.md)
- [設定仕様](/Users/USER/masahide/git/adjutant/doc/spec/configuration.md)
