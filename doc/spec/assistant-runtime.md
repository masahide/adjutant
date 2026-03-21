# Assistant Runtime 仕様

## 1. 目的

この文書は、Adjutant の assistant 実行系が workspace bootstrap、agent session 作成、compaction、summary batch、監査ログをどのように扱うかを定義する。

## 2. スコープ

### 含むもの

- `runAgent()` を中心にした assistant 実行フロー
- workspace bootstrap と Project Context 注入
- `pi-coding-agent` session 初期化
- compaction / pre-compaction memory flush
- summary batch と transcript 利用
- agent audit log

### 含まないもの

- proactive の queue / flusher
  - [proactive-routing.md](/Users/USER/masahide/git/adjutant/doc/spec/proactive-routing.md)
- memory search / write の詳細
  - [memory.md](/Users/USER/masahide/git/adjutant/doc/spec/memory.md)
- Docker sandbox の詳細
  - [sandbox.md](/Users/USER/masahide/git/adjutant/doc/spec/sandbox.md)
- ACP / worker 分離の詳細
  - [acp-architecture.md](/Users/USER/masahide/git/adjutant/doc/spec/acp-architecture.md)

## 3. 主要コンポーネント

- `src/assistant/agent-runner.ts`
- `src/assistant/agent-session-factory.ts`
- `src/assistant/pi-skills.ts`
- `src/assistant/workspace-bootstrap.ts`
- `src/assistant/bootstrap-context.ts`
- `src/assistant/compaction-runtime.ts`
- `src/assistant/session-compaction-store.ts`
- `src/assistant/markdown-summary-batch.ts`
- `src/control-plane/audit/agent-audit-log.ts`

## 4. 実行フロー

### 4.1 session 作成と prompt 実行

- worker 側の `AgentRunnerAdapter` は `session/prompt` を `runAgent()` へ橋渡しする
- `runAgent()` は `sessionKey`, `memoryScope`, `origin`, `isHeartbeat`, `memoryWriteEnabled` を受け取る
- `OPENAI_API_KEY` が有効な場合は `pi-coding-agent` 実 session を使う
- 未設定時は echo fallback / test mock runner が使われる

### 4.2 `pi-coding-agent` session 初期化

`createPiAgentSession()` は次を組み立てる。

- `AuthStorage`
- `ModelRegistry`
- `SettingsManager.inMemory()`
- `SessionManager.inMemory(workspaceDir)`
- 明示構築した `DefaultResourceLoader`
- `customTools`

custom tool の公開面は `tool_hub` 1 本に統一されている。sandbox 対象セッションでは `bash` と file tools を containerized 版へ差し替える。

skills discovery は `pi-coding-agent` 既存実装を使い、Adjutant 側では `DefaultResourceLoader.additionalSkillPaths` に次を追加する。

- `<projectRoot>/.agents/skills`
- `~/.agents/skills`

これにより、Pi 既定の `~/.pi/agent/skills` と `<workspaceDir>/.pi/skills` は維持したまま、Agent Skills 標準寄りの配置も探索対象になる。`projectRoot` は worker process の `cwd` を基準に決まり、ACP schema は拡張しない。

skill diagnostics は session 初期化時に warning ログへ流す。ただし、既定 path が存在しないだけの `skill path does not exist` は運用ノイズになるため suppress し、不正 `SKILL.md` や collision のみを warning として残す。

### 4.3 skills の利用フロー

- `session/prompt` の `prompt` は ACP 境界ではそのまま worker に渡す
- `runAgent()` は `createPiAgentSession()` で作った session を再利用する
- `pi-coding-agent` が system prompt へ skills catalog を注入する
- `/skill:name ...` は `pi-coding-agent` 側で `<skill ...>` block へ展開される

つまり Adjutant は skills の発見経路と session 初期化だけを担当し、catalog 注入や explicit expansion の本体実装は `pi-coding-agent` に委譲する。

## 5. Workspace Bootstrap

### 5.1 seed 対象

workspace 初期化では `assistant/prompts` から次を seed する。これらは `vendor/openclaw/docs/reference/templates` の取り込み元を repo 管理下へ複製したものとする。

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `HEARTBEAT.md`

brand-new workspace の場合のみ、追加で `BOOTSTRAP.md` を作成する。

### 5.2 Project Context 注入条件

main session での user turn のみ、bootstrap files を Project Context として注入する。

実条件:

- `origin=user`
- `isHeartbeat=false`
- `sessionKey=main`
- `memoryScope=main`

注入対象:

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `HEARTBEAT.md`
- `BOOTSTRAP.md`（存在時のみ）
- `MEMORY.md` / `memory.md`（存在時のみ）

`memory/YYYY-MM-DD.md` は自動注入しない。

## 6. Compaction / Memory Flush

### 6.1 pre-compaction memory flush

`resolveCompactionRuntimeSettings()` と `shouldRunPreCompactionMemoryFlush()` が flush 実行可否を判定する。

主条件:

- `ADJUTANT_MEMORY_FLUSH_ENABLED=true`
- main session
- 非 heartbeat
- workspace writable
- 同一 compaction cycle で未実行

しきい値は概ね次で計算する。

- `contextWindow - reserveTokensFloor - softThresholdTokens`

### 6.2 compaction metadata

`SessionCompactionStore` は `<stateDir>/worker/sessions.json` に次を保存する。

- `compactionCount`
- `memoryFlushCompactionCount`
- `memoryFlushAt`
- `contextTokens`
- `contextWindowTokens`

## 7. Summary Batch

`createMarkdownSummaryBatchService()` は transcript を走査し、daily memory へ Markdown を追記する。

既定入出力:

- input: `<stateDir>/agents/main/transcripts/`
- watermark: `<stateDir>/agents/main/summary-batch-watermark.json`
- output: `<workspaceDir>/memory/YYYY-MM-DD.md`

主な契約:

- `user` / `assistant` 行のみ対象
- `/` で始まる command 行は除外
- watermark は session ごとの `lastProcessedOffset` を持つ
- transcript truncate/rotate を検知したら offset を 0 に戻して再走査する

## 8. 監査ログ

`AgentAuditLog` は `<stateDir>/audit/agent-audit.ndjson` へ append-only で記録する。

対象イベント:

- `run.start`
- `run.end`
- `tool.start`
- `tool.end`
- `summary.batch`

`ADJUTANT_AGENT_AUDIT_LOG_ENABLED=false` で無効化できる。

## 9. 実装対応

- `src/assistant/agent-runner.ts`
- `src/assistant/agent-session-factory.ts`
- `src/assistant/pi-skills.ts`
- `src/assistant/workspace-bootstrap.ts`
- `src/assistant/bootstrap-context.ts`
- `src/assistant/compaction-runtime.ts`
- `src/assistant/session-compaction-store.ts`
- `src/assistant/markdown-summary-batch.ts`
- `src/agent-worker-acp/adapters/agent-runner-adapter.ts`
- `src/control-plane/audit/agent-audit-log.ts`

## 10. 関連文書

- [memory 仕様](/Users/USER/masahide/git/adjutant/doc/spec/memory.md)
- [proactive routing 仕様](/Users/USER/masahide/git/adjutant/doc/spec/proactive-routing.md)
- [sandbox 仕様](/Users/USER/masahide/git/adjutant/doc/spec/sandbox.md)
- [ACP 分離アーキテクチャ](/Users/USER/masahide/git/adjutant/doc/spec/acp-architecture.md)
