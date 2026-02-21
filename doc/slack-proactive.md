# Slack連動型 統合プロアクティブAIエージェント 要求仕様書

## 1. システムの目的

Slack上の全チャンネル・DMの通知および会話履歴を統合的に蓄積し、AIエージェントが「Slack全体で何が起きているか」を俯瞰（Omniscient）して把握できる環境を構築する。
特定のイベントや会話の流れを検知し、エージェントが自律的（プロアクティブ）に必要なチャンネルへ介入・返答を行うシステムを実現する。同時に、LLMのAPIコスト最適化と、システムのリアルタイム性を両立させる。

## 2. 全体アーキテクチャ方針（司令塔モデル）

OpenClawの機能を拡張し、**「Hub and Spoke（司令塔）」アーキテクチャ**を採用する。
チャンネルごとにセッション（記憶の記録先）は分離しつつも、思考と判断の主体は特権を持つ「メインセッション（司令塔エージェント）」に集約する。
処理の重さと即時性に応じて、**Fast Path（ルーター層）**、**Background Path（非同期インデックス）**、**Slow Path（ハートビート巡回）**の3層構造で全体を制御する。

## 3. 機能要件

### 3.1. Slack連携とルーター層（Fast Path）

- **全イベントの受信**: GatewayにてSlackからの全イベントをリアルタイムに受信し、標準のメッセージ形式に正規化する 。

- **統合タイムラインの構築**: 受信したイベントは、各チャンネル固有のJSONLセッションログに追記されると同時に、司令塔エージェントが俯瞰するための「統合タイムライン（例: 統合JSONLまたは `memory/timeline-YYYY-MM-DD.md`）」にも追記する。
- **軽量ルーターによる一次判定**: イベントは、メインエージェントに渡す前に軽量・高速なLLM（Gemini Flash等）で「即時対応が必要か」を判定する。
- **即時対応の実行（一括回収）**: ルーターが「要対応」と判定した場合、司令塔となるメインエージェントを起動する。メインエージェントは統合タイムラインを読み込むため、それまでルーターが「対応不要（ペンディング）」としてスルーしていた直前のメッセージ群もすべてコンテキストに含めて一括で状況を把握・処理する。

### 3.2. 記憶の二層化と非同期インデックス（Background Path）

OpenClawの標準機能を最大限活用し、コンテキストウィンドウの枯渇を防ぐ。

- **ログの即時追記**: ログはすべて追記専用（Append-only）のJSONL形式としてディスクに保存される 。

- **非同期インデックス化**: OpenClawの実験的機能（`experimental.sessionMemory: true`）を有効化し、SQLiteへのベクトル＋BM25ハイブリッド検索インデックスを構築する 。インデックスのトリガーは、`deltaMessages` や `deltaBytes` などの閾値を利用した非同期バッチ処理とする 。

### 3.3. 司令塔エージェントとクロスセッション介入

- **特権コンテキストのロード**: 司令塔となるメインセッションのみが、ユーザーの個人的な長期記憶である `MEMORY.md` を読み込む権限を持つ 。

- **他チャンネルへの介入**: 司令塔エージェントが特定のSlackチャンネルで返答やアクションが必要と判断した場合、クロスセッションツール（`sessions_send` や `message` ツールなど）を利用し、メインセッションにいながら該当チャンネルへ直接メッセージを送信する 。

### 3.4. ハートビート巡回と「文脈しおり」による補正（Slow Path）

ルーター層の判定漏れ（False Negative）を防ぐため、外部DBでの状態管理を行わないOpenClawネイティブな巡回タスクを実行する。

- **定期レビュータスク**: GatewayのCron機能等を利用し、一定間隔（例：15分毎）でタスクを起動する 。

- **「文脈しおり」による状態判定**:
  個別の「対応済みフラグ」は持たず、統合タイムライン（ログ）の**末尾のレコード**を判定基準とする。
- ログの最後尾が `user`（Slackからの通知）であり、かつ最終更新から一定時間経過している場合のみ、「未対応のペンディングが放置されている」と見なしてメインエージェントを起動する。
- 最後尾が `assistant`（エージェントのアクション）であれば、「最新状態まで対応済み」と見なし、処理をスキップする。

- **遅延対応アクション**: 起動したメインエージェントが要対応事案を発見した場合、「先ほどの件ですが…」といった時間的文脈を踏まえてSlackへクロスセッションで対応を実行する。実行後、ログ末尾に `assistant` のレコードが追記されるため、次回のハートビートは自然にスキップされる。

## 4. 非機能要件

- **排他制御（セッションロック）の回避**: メインエージェントの実行中はセッションがロックされるため、全通知を直接メインエージェントに流し込まず、ルーター層による流量制限を徹底する。
- **コスト最適化**: ツール実行や文脈理解を伴う重い推論（LLM）は、要対応事案とハートビートのみに限定し、無駄なAPIコールを防ぐ。
- **情報隔離とセキュリティ**: グループチャットやパブリックチャンネル固有のセッションでは `MEMORY.md` を絶対にロードさせず 、プライバシーの保護を徹底する。司令塔のみが全容を知る設計とする。

## 5. 実装で確定した追加要件（2026-02-20）

### 5.1. 単一ランタイム構成

- `pnpm run assistant` 起動で、API/UI・Heartbeat・ChannelManager・Slack plugin を同一プロセスで起動する。
- チャネル連携は `ChannelIngestionPlugin` 契約（`startAccount/stopAccount`）と `ChannelManager` に統一する。

### 5.2. Fast Path の判定契約

- ルーター判定結果は `RouteDecision`（`run/pending/system/drop`）で表現する。
- `drop=true` は他フラグと排他とする。
- `run=true` と `pending=true` は同時に許可しない。
- self-message は `post/reaction/notification` をすべて `drop` する（ループ防止）。
- self 判定不可時の fail-safe は `post` を `drop`、`reaction/notification` を `system-only`（`run` 禁止）とする。

### 5.3. 通知キューとデバウンス

- 通知キューはセッション系キー単位で有界運用する。
- 既定値は `cap=20`、`debounceMs=1000`、`dropPolicy=summarize`、`maxDispatchChars=4000`、`maxEventUidsPerDispatch=50` とする。
- queue key は `accountId:sessionKey:senderId:threadKey` で生成し、欠落時は `unknown-sender` と `channel:{channelKey|sessionKey}` にフォールバックする。

### 5.4. Dispatch/API 契約

- Fast Path は `NormalizedEvent` 群を `ChatDispatchRequest` に変換し、`POST /api/chat/messages` へ送る。
- API最小契約は `message/sessionKey/idempotencyKey` を維持する。
- `idempotencyKey` は `sha256(sessionKey + "\\n" + sorted(eventUids).join("\\n"))` で決定的に生成する。
- 文字数上限超過時は切り詰めを行い、`messageTruncated/originalCharCount/dispatchedCharCount` を付与する。

### 5.5. 統合タイムラインとセッション JSONL の二重追記

- inbound event は統合タイムライン（`memory/timeline.jsonl`）と session JSONL の二重追記を行う。
- 書き込み順は timeline を先行し、失敗時は `pending-timeline` として run/pending 判定を停止する。
- session 側失敗時は `pending-session-backfill` に退避し、run/pending は継続する。
- retry は `uid` 単位で idempotent に再実行し、未解消が長時間継続した場合は warning を出す。

### 5.6. Slow Path（Heartbeat）判定の具体化

- 判定データソースは統合タイムライン `memory/timeline.jsonl` のみを使用する。
- 末尾から逆走査し、最初の `role=assistant | role=tool | recordType=action` を最新対応境界として打ち切る。
- 末尾から境界までに stale な `recordType=event && role=user && kind=post` がある場合のみ起動する。
- 該当 `uid` が `pending-session-backfill` に存在する場合は、文脈欠落を避けるため `skip` する。

### 5.7. MEMORY 権限分離（実装確定）

- `runAgent` の `memoryScope` で main/spoke を分離する。
- main セッションのみ `MEMORY.md` / `memory/*.md` をロードし、spoke セッションでは常時 skip する。

### 5.8. 軽量LLM一次判定の実装拡張ポイント

- `TriggerFilter` は一次判定に加えて `secondaryClassifier` を受け取れる設計とする。
- `secondaryClassifier` は timeout（既定 `1000ms`）時に一次判定へフォールバックする。
- route LLM の実行プロバイダは OpenAI とし、環境変数は `ADJUTANT_ROUTE_LLM_ENABLED` / `ADJUTANT_ROUTE_LLM_MODEL` / `ADJUTANT_ROUTE_LLM_TIMEOUT_MS` / `ADJUTANT_ROUTE_LLM_MAX_CONCURRENT` / `OPENAI_API_KEY` を使用する。
- route LLM の出力契約は JSON（`{ outcome: "run" | "pending", confidence?: number, reason?: string }`）とし、契約外値・不正JSON・例外時はいずれも deterministic 判定へフォールバックする。
- route LLM の判定監査ログは本文を含めず、`uid` / `eventKind` / `model` / `outcome` / `durationMs` / `fallback reason` を記録する。

### 5.9. メモリ検索ツール（`memory_search` / `memory_get`）の実装確定

- main セッションにのみ `memory_search` / `memory_get` を登録し、spoke セッションでは登録しない。
- 検索対象は `<workspace>/MEMORY.md` と `<workspace>/memory/**/*.md` に限定する。
- 検索は SQLite（FTS5 + sqlite-vec）によるハイブリッドとし、埋め込みは OpenAI API を利用する。
- `sqlite-vec` ロード失敗時は fail-fast（`index_unavailable`）でメモリ検索機能を無効化する。
- `memory_get` は workspace 外参照、symlink、`.md` 以外を拒否し、契約済みエラー形式を返す。
- ツール返却契約は OpenClaw 準拠の `jsonResult` 形式（`content[].text` + `details`）とする。
- 環境変数と既定値は以下を採用する:
  - `ADJUTANT_MEMORY_SEARCH_ENABLED=true`
  - `ADJUTANT_MEMORY_SEARCH_MODEL=text-embedding-3-small`
  - `ADJUTANT_MEMORY_SEARCH_MAX_RESULTS=5`
  - `ADJUTANT_MEMORY_SEARCH_MIN_SCORE=0`
  - `ADJUTANT_MEMORY_SEARCH_VECTOR_ENABLED=true`
  - `ADJUTANT_MEMORY_SEARCH_SQLITE_VEC_PATH=""`（空文字時は sqlite-vec 既定探索）

### 5.10. Pre-Compaction Memory Flush / Context Compaction 契約（実装確定）

- `runAgent` は main セッション実行時、通常プロンプト前に `getContextUsage()` を参照し、閾値超過時のみ pre-compaction memory flush turn を実行する。
- flush 判定式は `threshold = contextWindow - reserveTokensFloor - softThresholdTokens` とし、`tokens >= threshold` の場合のみ実行する。
- 同一 compaction cycle での重複実行を避けるため、`sessions.json` の `memoryFlushCompactionCount === compactionCount` の場合は flush をスキップする。
- flush turn の中間出力（text delta / tool result）はユーザー向け応答へ混入させない。`memory_write` の副作用（`MEMORY.md` / `memory/*.md` 更新）のみ許可する。
- `context_overflow` 発生時は `shrinkPrompt` より `session.compact()` を優先し、compaction 後に同一 prompt で 1 回再試行する。
- `sessions.json` の拡張項目は以下を採用する:
  - `compactionCount?: number`
  - `memoryFlushAt?: string`（ISO8601）
  - `memoryFlushCompactionCount?: number`
  - `contextTokens?: number | null`
  - `contextWindowTokens?: number | null`
- spoke / heartbeat / workspace read-only の条件では pre-compaction memory flush を実行しない。
- 環境変数と既定値は以下を採用する:
  - `ADJUTANT_COMPACTION_ENABLED=true`
  - `ADJUTANT_COMPACTION_RESERVE_TOKENS_FLOOR=20000`
  - `ADJUTANT_MEMORY_FLUSH_ENABLED=true`
  - `ADJUTANT_MEMORY_FLUSH_SOFT_THRESHOLD_TOKENS=4000`
  - `ADJUTANT_MEMORY_FLUSH_PROMPT=<既定 pre-compaction prompt>`
  - `ADJUTANT_MEMORY_FLUSH_SYSTEM_PROMPT=<既定 system prompt>`
