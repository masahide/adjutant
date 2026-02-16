# OpenClaw / pi-coding-agent セッションJSONL・sessionId調査メモ

## 調査目的

- `pi-coding-agent` が保存する `jsonl` セッションの実フォーマットを整理する。
- 会話履歴が「全量保存」か「最新のみ保存」かを整理する。
- `sessionId` がどこで使われ、トークンキャッシュとどう結びつくかを整理する。
- `previous_response_id` 利用有無を整理する。

## 結論（要点）

1. セッションファイルは JSONL で、1行目が `session` ヘッダ、2行目以降が append-only のツリーエントリ。
2. 保存は「最新のみ」ではなく、履歴エントリを追記し続ける（削除更新しない）。
3. モデル送信時は、保存済み履歴をそのまま全行送るのではなく `buildSessionContext()` で再構成して送る。
4. compaction 後は「要約 + keep対象 + compaction後メッセージ」が LLM コンテキストになる。
5. `sessionId` は `prompt_cache_key`（Codex は加えて `session_id` ヘッダ）に使われる。
6. `previous_response_id` は `pi-coding-agent` / `pi-ai` 本線では使っていない。

## 1. JSONL の実フォーマット

### 1.1 ヘッダ行

- 先頭行は `type: "session"` のヘッダ。
- 例:

```json
{
  "type": "session",
  "version": 3,
  "id": "<session-uuid>",
  "timestamp": "2026-02-16T10:00:00.000Z",
  "cwd": "/path/to/project"
}
```

### 1.2 エントリ行（2行目以降）

- 各行は `SessionEntryBase` を持つ:
  - `id`
  - `parentId`
  - `timestamp`
- 主な `type`:
  - `message`（`user` / `assistant` / `toolResult` など）
  - `thinking_level_change`
  - `model_change`
  - `compaction`
  - `branch_summary`
  - `custom`
  - `custom_message`
  - `label`
  - `session_info`

### 1.3 ツリー構造

- `parentId` で親子を結ぶツリー構造。
- 線形ログではなく、ブランチ切替を同一ファイル内で表現できる。
- 現在位置は `leaf` として管理される。

## 2. 永続化の挙動（全履歴か最新のみか）

### 2.1 保存方式

- append-only（追記専用）。
- 新しいイベントは `appendMessage()` / `appendCompaction()` などで 1 エントリずつ追加。
- 既存エントリを「最新だけ残して削除」するロジックはない。

### 2.2 実運用上の意味

- セッションファイルには履歴が蓄積される。
- ただし LLM 入力はこの生ログ全体を毎回そのまま送るわけではない（後述）。

### 2.3 flush タイミングの注意

- 実装上、初回アシスタント応答が出るまでファイル書き出しを遅延させる分岐がある。
- その後は追記で永続化される。

## 3. モデルへ渡す履歴の組み立て

### 3.1 復元入口

- セッション再開時、`SessionManager.buildSessionContext()` で履歴を再構成。
- その結果 `existingSession.messages` が Agent に復元される。

### 3.2 推論時

- `agentLoop` は `context.messages`（現在までの会話）を使って LLM コンテキストを作る。
- つまり「最新1件だけ」ではなく、現在コンテキスト全体を送る。

### 3.3 compaction がある場合

- `buildSessionContext()` は compaction エントリを検出すると、次の形に再構成する:
  - compaction summary
  - `firstKeptEntryId` 以降の keep 範囲
  - compaction 後のメッセージ
- そのため、古い履歴は「要約表現」に置き換えられて LLM に渡される。
- ただし元の過去エントリ自体は JSONL から削除されない。

## 4. sessionId とトークンキャッシュ

### 4.1 sessionId の流れ

1. `SessionManager.getSessionId()` を `Agent` 作成時に渡す。
2. Agent から `AgentLoopConfig.sessionId` として stream 関数へ渡る。
3. `pi-ai` の OpenAI/Codex provider が API payload/header へ反映する。

### 4.2 OpenAI Responses

- `prompt_cache_key: options?.sessionId` を設定。
- `cacheRetention` が `none` のときは `prompt_cache_key` を外す。

### 4.3 OpenAI Codex Responses

- `prompt_cache_key: options?.sessionId`
- `session_id` HTTP ヘッダも設定

## 5. previous_response_id との関係

- `vendor/pi-mono/packages/ai` / `packages/agent` / `packages/coding-agent` には
  `previous_response_id` / `previousResponseId` の実装利用が見当たらない。
- 会話連鎖は `sessionId`（+履歴メッセージ、+provider側キャッシュ）で扱う構成。

## 6. OpenClaw 側での補足

- OpenClaw 側は `previous_response_id` を Gateway schema 上は受理する定義がある。
- ただし `pi-coding-agent` 実行経路で `previous_response_id` を引き回して利用はしていない。
- OpenClaw は送信前に履歴 sanitize/truncate を追加適用する経路を持つため、保存全履歴が常にそのまま送信されるわけではない。

## 7. 主要参照

- `vendor/pi-mono/packages/coding-agent/src/core/session-manager.ts`
- `vendor/pi-mono/packages/coding-agent/docs/session.md`
- `vendor/pi-mono/packages/agent/src/agent.ts`
- `vendor/pi-mono/packages/agent/src/agent-loop.ts`
- `vendor/pi-mono/packages/ai/src/providers/openai-responses.ts`
- `vendor/pi-mono/packages/ai/src/providers/openai-codex-responses.ts`
- `vendor/openclaw/src/gateway/open-responses.schema.ts`
- `vendor/openclaw/src/agents/pi-embedded-runner/run/attempt.ts`
