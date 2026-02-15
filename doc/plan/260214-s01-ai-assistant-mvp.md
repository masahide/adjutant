# AI Assistant MVP 要件定義

## 1. 概要と目的 Overview and Purpose

### What

Adjutant が収集済みの Slack イベント JSONL を AI に読み込ませ、プロアクティブに動作するパーソナル AI アシスタントを構築する。
OpenClaw のハートビート機構・メモリシステム・メッセージキューを参考に、定期ポーリングで「注目すべきことがあるか」を AI に判断させ、ユーザーへ通知する。
対話 UI は assistant-ui (`@assistant-ui/react`) を採用し、ブラウザ上でストリーミングチャットを提供する。

### Why

- Slack の大量メッセージから「自分に関係のある情報」を AI が自動的にピックアップする
- ユーザーが能動的にログを読む必要をなくし、重要な情報の見落としを防ぐ
- 対話形式で「あの件どうなった？」と聞ける自然なインターフェースを提供する
- AI が過去の文脈を記憶し、繰り返しの説明なしに「阿吽の呼吸」で応答する

### How

```
[既存] CDP → SlackAdapter → JSONL (data/YYYY/MM/DD/slack/events.jsonl)
                                ↓
[新規] EventReader ← JSONL ファイル読み込み（Heartbeat 文脈用）
          ↓                     ↓
[既存/新規] monitor / system / cron → SystemEventQueue（外部トリガ投入）
                                ↓
[新規] MemoryReader ← MEMORY.md / memory/YYYY-MM-DD.md 読み込み
                                ↓
[新規] ContextBuilder → AI 向けコンテキスト組み立て（イベント + メモリ）
                                ↓
[新規] HeartbeatRunner ← 定期ポーリング（OpenClaw 模倣）
          ↓                     ↓
[新規] CommandQueue ← 排他制御（ユーザー入力の直列化 + Heartbeat の混雑判定参照）
                                ↓
[新規] AgentRunner ← pi-coding-agent SDK でセッション管理・LLM 呼び出し
          ↓                     ↓
[新規] MemoryWriter ← MEMORY.md / memory/YYYY-MM-DD.md 書き出し
                                ↓
[既存] SDK Session Transcript(JSONL) + Session Entry Store(`sessions.json`) を永続化
                                ↓
[新規] TranscriptReader ← SDK トランスクリプトを UI 表示/直近窓へ投影
                                ↓
[新規] API Server (HTTP/SSE) ← ストリーミング応答
                                ↓
[新規] Web UI (assistant-ui) ← ブラウザ対話
```

---

## 2. 仕様と受け入れ条件

### 2.1 スコープ Scope

**今回やること:**

1. **JSONL イベント読み込みモジュール** — 日付指定で `data/YYYY/MM/DD/slack/events.jsonl` を読み、`NormalizedEvent[]` として返す
2. **システムイベントキュー** — セッション単位のエフェメラルなインメモリキューに通知テキストを蓄積し、次のエージェントプロンプトに前置き注入する（OpenClaw `system-events.ts` パターン。`sessionKey` 単位で分離し、別セッションへの混入を防ぐ）。投入元は monitor / system / cron などの外部トリガ由来イベントとし、ChatHandler は投入を行わず drain のみ実行する。既存 CDP パイプラインへの hook は MVP では行わない
3. **AI コンテキストビルダー** — イベント配列 + メモリファイルを LLM が理解しやすいプロンプトに変換する
4. **ハートビートランナー** — 設定間隔（デフォルト 30 分）で AI にポーリングし、注目すべきイベントがあればアラートを生成する（OpenClaw `heartbeat-runner` パターン）
5. **コマンドキュー（排他制御）** — OpenClaw の `CommandLane` パターンに合わせ、`main`（グローバル）レーン + `session:<sessionKey>` レーンで直列化する。ユーザー入力実行は両レーン経由で排他し、異なるセッション間の混線を防ぐ。Heartbeat はレーンに enqueue せず、`main` レーン混雑（`getQueueSize("main") > 0`）時は `requests-in-flight` でスキップし `heartbeat-wake` で再試行する
6. **エージェントランナー** — `@mariozechner/pi-coding-agent` SDK を使い、セッション管理・LLM 呼び出し・ストリーミングを行う
7. **メモリシステム（簡易版）** — エージェントが重要と判断した情報を `MEMORY.md`（長期）/ `memory/YYYY-MM-DD.md`（日次）に書き出す。次のプロンプトでこれらを読み込み、文脈を保持する（OpenClaw メモリパターンの簡易実装）
8. **セッション永続化** — pi-coding-agent SDK のセッション管理を正（source of truth）とする。永続化は OpenClaw と同様に SDK トランスクリプト JSONL + Session Entry Store（`sessions.json`）で行い、UI 履歴/API 取得もこの保存データを投影して提供する（別の独立ログストアは持たない）
9. **ワークスペースファイル** — `HEARTBEAT.md`（チェックリスト）、`SOUL.md`（エージェントのペルソナ・口調設定）、`USER.md`（ユーザーの情報・好み）、`AGENTS.md`（運用ルール・応答ポリシー）をエージェントの動作カスタマイズに使用する
10. **ハートビート用モデル設定** — ハートビートには安価なモデル（例: GPT-4o mini, Gemini Flash）を使用し、対話には上位モデル（Claude）を使う設定を可能にする（OpenClaw モデルカスケードパターン）
11. **API サーバー** — HTTP エンドポイント + SSE ストリーミングで assistant-ui フロントエンドと接続する。メッセージ送信/キャンセル（POST）とストリーム取得（GET SSE）を分離する 2 段パターンを採用
12. **Web UI** — `@assistant-ui/react` を使ったチャット画面。ハートビートアラートの表示と自由対話の両方を提供する

**MVP必須（優先実装）:**

1. JSONL 読み込み + `SystemEventQueue` 前置き注入（`sessionKey` 分離）
2. `CommandQueue` による同一セッション排他と別セッション分離
3. Heartbeat コア契約（`HEARTBEAT_OK` 抑制、空ファイルスキップ、`activeHours`、重複抑止）
4. pi-coding-agent SDK 実行基盤（lock/repair/open/create/dispose）
5. 簡易メモリ（`MEMORY.md` / `memory/YYYY-MM-DD.md`）の読み書き
6. ワークスペースファイル反映（`SOUL.md` / `USER.md` / `AGENTS.md` / `HEARTBEAT.md`）
7. assistant-ui 連携の 2 段 API（`POST /api/chat/messages` + `GET /api/chat/runs/:runId/stream`）+ キャンセル API（`POST /api/chat/abort`）
8. Heartbeat API（`POST /api/heartbeat/run` + `GET /api/events/stream` + `GET /api/heartbeat/last`）+ 履歴取得 API（`GET /api/chat/history?sessionKey=...`）

**成果物:**

- `src/assistant/` — バックエンド実装
- `src/ui/` — フロントエンド（assistant-ui ベース）
- `HEARTBEAT.md` — ハートビートチェックリスト（ユーザー設定可能）
- `SOUL.md` — エージェントのペルソナ定義（ユーザー設定可能）
- `USER.md` — ユーザー情報定義（名前、所属、好み等）
- `AGENTS.md` — ワークスペース運用ルール定義（ユーザー設定可能）
- テストコード
- この要件定義ドキュメント

**制約:**

- 既存の CDP → JSONL パイプライン (`src/slack/`, `src/io/`) には手を入れない
- LLM プロバイダーは設定で差し替え可能とし、MVPのデフォルトは Claude とする（pi-coding-agent SDK 経由）
- ベクトル検索・SQLite インデックスは導入しない（メモリファイルは全文読み込み）

### 2.2 非スコープ Non Scope

- GitHub / git-local イベントの取り込み
- ベクトル DB / SQLite によるセマンティック検索（将来: sqlite-vec + FTS5 のハイブリッド検索。OpenClaw はベクトル 70% + BM25 30% の加重平均）
- 自動メモリフラッシュ / 事前圧縮フラッシュ（将来: コンテキスト 80% 超過時にサイレントターンで重要事実を MEMORY.md に退避。OpenClaw `compaction.memoryFlush` パターン）
- 回転型ハートビート（将来: 全チェックではなく「最も overdue なタスク」を 1 つだけ実行する最適化）
- Cron ジョブ / 外部 Webhook トリガー（ハートビートのみで MVP は十分）
- ユーザー認証・マルチテナント
- モバイル対応
- Slack への書き戻し（メッセージ送信）等の外部副作用の実行。MVP ではアラート・提案の生成のみ

**今回延期（MVP+）:**

- セッション切り替え UI（初版は単一セッション固定で可）

### 2.3 ユースケース Use Cases

**UC-1: ハートビートによるプロアクティブ通知**

1. ハートビートタイマーが発火する（30 分間隔）
2. `activeHours` 設定がある場合、現在時刻が時間外であればスキップする（quiet-hours）
3. Heartbeat 実行前に `getQueueSize("main")` を確認する。`> 0` の場合は `requests-in-flight` としてスキップし、`heartbeat-wake` が 1 秒後に再試行する
4. `heartbeat.session` 指定は OpenClaw 解決規則に従う。無効/他 agent のセッション指定は main セッションへフォールバックする
5. HEARTBEAT.md を読み込み、実質空であればモデル呼び出しなしでスキップする（AC-09）
6. JSONL から「直近 N 分 + 上限件数」でイベント窓を読み込む
7. HEARTBEAT.md のチェックリスト + systemPrompt（SOUL.md + USER.md + AGENTS.md）+ メモリファイルとイベントを AI に渡す
8. AI が「注目すべきこと」を判断する
   - 何もなければ `HEARTBEAT_OK` を返し、UI には通知しない（出力抑制）
   - 注目事項があればアラートテキストを生成し、Heartbeat イベントを発火する。API Server は `event: heartbeat` として UI へ push する（OpenClaw `onHeartbeatEvent` パターン）
9. HeartbeatRunner 自体は SystemEventQueue へアラート要約を enqueue しない（OpenClaw 実装方式）。UC-3 のフォローアップはトランスクリプト履歴・メモリ・既存 SystemEvent（monitor/system/cron 由来）を参照して行う
10. ハートビートの実行は内部処理として扱う。OpenClaw 実装に合わせ、`updatedAt` は常時固定ではなく、抑制系経路（`ok-token` / `ok-empty` / `duplicate` など）では復元し、通知送信時は更新されうる

**UC-2: ユーザーからの対話クエリ**

1. ユーザーが UI のチャット欄に「今日の #general で何が話されてた？」と入力する
2. ChatHandler がリクエストをコマンドキューに投入する
3. タスク関数内で SystemEventQueue を drain し、MEMORY.md とセッション履歴を合わせてコンテキストを構築する
4. AI がストリーミングで回答する
5. assistant-ui がリアルタイムで表示し、対話履歴がセッション JSONL に追記保存される

**UC-3: アラートへのフォローアップ（Human-in-the-Loop）**

1. ハートビートアラートが UI に表示される（例：「#incident に障害報告がありました。詳細を確認しますか？」）
2. ユーザーがアラートに対して「詳しく教えて」と返信する
3. AI がセッション履歴 + メモリを参照し、追加の詳細を返す
4. **MVP では外部副作用（Slack への書き戻し、メール送信等）は実行しない**。提案テキストと追加説明の提示に限定する

**UC-4: メモリの蓄積と活用**

1. 対話の中でユーザーが「この件は覚えておいて」と指示する
2. AI が memory/YYYY-MM-DD.md に情報を書き出す
3. 後日、ユーザーが「あの件の進捗は？」と聞くと、AI がメモリから文脈を復元して回答する

**メモリ書き込みガード:** メモリへの書き込みは **明示的なユーザー発話トリガー時のみ** 許可する。ハートビートによる自動実行時はメモリ書き込みツールを無効化し、意図しないメモリ汚染を防ぐ。具体的には `AgentRunOptions.isHeartbeat === true` の場合、`memory_write` ツールをツールリストから除外する

**UC-5: セッション継続**

1. プロセスを再起動する
2. SDK の SessionManager が自身のセッションファイルを読み込み、LLM 向けの会話コンテキストを復元する（source of truth）
3. SDK トランスクリプト JSONL を読み込み、UI にメッセージ履歴を表示する
4. ユーザーが「さっきの続き」と言えば、SDK セッション由来の文脈で応答する

### 2.4 受け入れ条件 Acceptance Criteria

この節の AC 番号は `doc/mvp-proactive-assistant-requirements.md` の `AC-01..AC-22` に一致させる。

**AC-01: Slackイベント保存**

- Slack イベントが `adjutant.event.v1.1` 形式で JSONL に追記保存される

**AC-02: JSONL文脈注入**

- AI 応答時に JSONL 由来のイベント窓が入力コンテキストへ取り込まれる

**AC-03: SDK実行手順準拠**

- OpenClaw 準拠の SDK 実行手順（lock→open→create→subscribe→dispose）を満たす

**AC-04: 同一sessionKey排他**

- 同一 `sessionKey` で同時実行が発生しない

**AC-05: sessionKey分離**

- 異なる `sessionKey` 間でコンテキストが混線しない

**AC-06: 失敗時再試行**

- 一時失敗時に 1 回再試行/切り詰め再試行が機能する

**AC-07: HEARTBEAT_OK抑制**

- `HEARTBEAT_OK` 抑制時は `HeartbeatRunResult.status: "ran"` を維持し、`HeartbeatEventPayload.status: "ok-token" | "ok-empty"` が記録される

**AC-08: Heartbeatアラート通知**

- 注目イベント時に Heartbeat アラートが通知される

**AC-09: 空HEARTBEATスキップ**

- `HEARTBEAT.md` 実質空で `status: "skipped"` になる（モデル呼び出しなし）

**AC-10: トランスクリプト永続化**

- `sessions.json` の Session Entry（`sessionKey -> sessionId/sessionFile`）と、対応するセッショントランスクリプト JSONL が永続化される

**AC-11: メモリ書き込みガード**

- 明示指示時のみメモリ書き込みされ、次回ターンで再利用される。Heartbeat 実行時は書き込まれない

**AC-12: SOUL反映**

- `SOUL.md` が通常対話/Heartbeat の応答方針に反映される

**AC-13: SystemEventQueue注入/排出**

- SystemEventQueue が `sessionKey` ごとに注入・drain される

**AC-14: UI表示とHeartbeat状態表示**

- `assistant-ui` でストリーミング表示され、`state: "final"` で完了確定して履歴保存される。`state: "delta"` が 0 件でも `state: "final"` の `message` で本文表示を更新できる。Heartbeat 状態は `GET /api/events/stream` の `event: heartbeat`（SSE push）で更新し、`GET /api/heartbeat/last` は初期表示・再接続時のスナップショット取得に使える

**AC-15: メモリ参照（通常/Heartbeat）**

- 通常対話/Heartbeat の両方で `MEMORY.md` と当日・前日メモが入力コンテキストへ取り込まれる

**AC-16: 重複通知抑制**

- 24時間以内の同一 Heartbeat 本文は `reason: "duplicate"` で抑制され、`HeartbeatRunResult.status: "ran"` を維持する

**AC-17: トランスクリプト直近窓注入**

- AI 実行時にセッショントランスクリプト直近窓が入力へ取り込まれ、再開時の文脈復元に利用される

**AC-18: readiness失敗の記録**

- アラート配信前の readiness 失敗時に `HeartbeatRunResult.status: "skipped"` と `HeartbeatEventPayload.status: "skipped"` が記録される。`ok-token`/`ok-empty` の可視化判定側 readiness 失敗は `HeartbeatRunResult.status: "ran"` と `HeartbeatEventPayload.status: "ok-token" | "ok-empty"` を維持する

**AC-19: 終端一意性**

- 致命的エラー時は `state: "error"` を送出して終端する。終端 state（`final` / `aborted` / `error`）は `runId` ごとに 1 回

**AC-20: Current time注入**

- Heartbeat 送信 Body 末尾に `Current time: <formattedTime> (<userTimezone>)` 行が注入され、同一実行で重複挿入されない

**AC-21: 冪等再送**

- 同一 `idempotencyKey` 再送時は冪等処理され、既存 `runId` を返して重複 run を作らない（OpenClaw `chat:${idempotencyKey}`）

**AC-22: requests-in-flight再試行**

- `requests-in-flight` 時は `status: "skipped"` で記録され、1秒後再試行が行われる

**補助検証（トレーサビリティ外）**

- P-01: `pnpm run assistant` で API サーバーと Web UI が起動し、チャット画面が表示される
- P-02: `pnpm run check` が成功し、既存 Slack 収集パイプラインに破壊的変更がない
- P-03: `heartbeat.session` に無効/他 agent のセッションを指定した場合、Heartbeat は main セッションへフォールバックして継続される

### 2.5 既知の制約 Known Limitations

- メモリファイルは全文読み込み（ベクトル検索なし）。ファイルが大きくなるとコンテキストウィンドウを圧迫する
- JSONL の窓読み（sinceMinutes + limit）で運用するため、古い文脈の取りこぼしが発生する可能性がある
- ハートビート重複排除は Session Entry Store（`sessions.json`）のエントリ（`lastHeartbeatText` / `lastHeartbeatSentAt`）に依存する。プロセス再起動後も継続される
- セッションコンパクション（自動要約・圧縮）は未実装。履歴が長くなると手動で `/new` 相当の操作が必要
- 実行中 run のキャンセルは `POST /api/chat/abort` と `/stop`（停止トリガー文字列）で対応する。実行中 run への steer（途中割り込み追加入力）は未実装
- pi-coding-agent SDK のバージョンに依存する

### 2.6 セキュリティ Security

- API サーバーは既定で `127.0.0.1` にのみバインドし、外部公開を前提にしない
- Slack トークンや個人情報を UI ログ・SSE レスポンスに平文表示しない
- JSONL を外部共有する場合はマスキング手順を用意する（MVP では手動）
- 副作用ツールを将来有効化する場合は、実行先を制限したサンドボックスを推奨する

### 2.7 可観測性 Observability

- Heartbeat 実行結果（status, modelId, contentHash）をイベントログに記録し、コスト分析・デバッグを可能にする
- セッション単位で run の状態遷移をログに記録する（開始・完了・失敗・リトライ）
- SystemEventQueue の drain 件数をログに残し、キュー滞留の検知に使う

### 2.8 性能目標 Performance

- 通常チャット応答の初回トークン開始を **5 秒以内**（ローカル開発環境）を目標とする
- ハートビート 1 回あたりの LLM 呼び出しは 30 秒以内に完了すること（タイムアウト上限）

### 2.9 順序保証 Ordering

- 同一セッション内のイベントは、SDK トランスクリプトへの保存順と UI 表示順が一致すること
- CommandQueue 内の待ち行列は投入順（FIFO）を維持すること
- SSE の `event frame seq` は optional とし、broadcast 配信時はグローバル単調増加の `seq` を付与する。targeted 配信（session/node 宛て）では `seq` 省略を許容し、クライアントは `seq` が付いたフレームのみ欠落・逆転を検知すること。`chat` payload 内の `seq` は runId ごとの単調増加として別に扱うこと

---

## 3. 前提技術スタック

- **Language**: TypeScript 5.x, ESM
- **Runtime**: Node.js (tsx)
- **AI SDK**: `@mariozechner/pi-coding-agent`（セッション管理: `createAgentSession`, `SessionManager`）、`@mariozechner/pi-ai`（LLM 呼び出し: `streamSimple`）
- **LLM**: Anthropic Claude (pi-coding-agent 経由)。ハートビートには安価なモデル（GPT-4o mini 等）を設定可能（モデルカスケード）
- **Frontend**: `@assistant-ui/react` + React 19
- **Bundler/Dev**: Vite（フロントエンド用）
- **API**: Node.js HTTP サーバー + SSE ストリーミング
- **Testing**: Node.js `--test` モジュール（既存と同じ）
- **Style Guide**: 既存の Prettier / ESLint 設定に準拠

---

## 4. インターフェース契約

### 4.1 モジュール境界

#### EventReader

```typescript
// src/assistant/event-reader.ts
export type ReadEventsOptions = {
  dataDir: string;
  date?: string; // "YYYY-MM-DD" (default: today)
  kinds?: string[]; // filter by event kind
  channels?: string[]; // filter by channel_id
  sinceMinutes?: number; // 直近 N 分以内のイベントのみ (default: 60)
  limit?: number; // 最大取得件数、新しい順に切り詰め (default: 200)
};

export function readEvents(opts: ReadEventsOptions): Promise<NormalizedEvent[]>;
```

#### SystemEventQueue

```typescript
// src/assistant/system-event-queue.ts
// OpenClaw の system-events.ts パターンを簡易実装。
// 次のプロンプト構築時に drain して前置き注入する。
//
// --- MVP での投入元 ---
// 1. monitor/system/cron など外部トリガ由来イベント:
//    enqueueSystemEvent(text, { sessionKey, contextKey? }) で投入する。
//    （OpenClaw の monitor + system-event + cron の実装パターン）
// 2. ChatHandler (API Server): キューへの投入は行わず、CommandQueue タスク関数内で
//    drain のみ実行して次回プロンプトへ前置き注入する（OpenClaw 実装方式に合わせる）。
// ※ 既存 CDP → JSONL パイプラインへの直接 hook は MVP では行わない。
//    リアルタイム投入（file watcher / pipeline hook）は §10 次フェーズ候補。

// SystemEvent はキュー格納要素の最小型。ルーティング情報は含めない（OpenClaw 準拠）。
export type SystemEvent = {
  text: string;
  ts: number; // epoch ms
};

// enqueue 時のオプション。sessionKey は必須のルーティングキー。
// contextKey は SessionQueue 側の補助状態（lastContextKey）としてのみ保持し、
// SystemEvent 本体には格納しない。
export type SystemEventEnqueueOptions = {
  sessionKey: string; // 必須（ルーティングキー）
  contextKey?: string; // 同一文脈判定用キー（任意）
};

// --- キュー制約 ---
// - セッション単位の FIFO キュー。最大 MAX_EVENTS = 20 件。超過時は古い方を破棄する
//   （OpenClaw system-events.ts:7 準拠）
// - 連続する同一テキストのイベントはドロップする（連続重複排除）
//   前回 enqueue されたテキストと同一の場合は無視して蓄積しない
//   （OpenClaw system-events.ts:69-71 準拠）
// - drain 後はキューを空にし、lastText をリセットする
// - contextKey を使って文脈変化を検知できるようにする（任意）
//   （OpenClaw isSystemEventContextChanged パターン）

// OpenClaw 契約に合わせ、enqueue/drain は text ベースを基本とする。
// ts を含むエントリ列が必要な場合のみ drainSystemEventEntries を使用する。
export function enqueueSystemEvent(text: string, opts: SystemEventEnqueueOptions): void;
export function drainSystemEventEntries(sessionKey: string): SystemEvent[];
export function drainSystemEvents(sessionKey: string): string[];
export function peekSystemEvents(sessionKey: string): string[];
export function hasSystemEvents(sessionKey: string): boolean;
// isSystemEventContextChanged: Node presence / monitor イベントなどで
// contextKey を使った文脈変化判定を行う際に使用する。
// 例: contextKey = "node:<host>:<ip>" のように供給元が決めたキーで重複投入を抑制する。
// MVP では任意実装（なくても動作する）。将来のリアルタイム投入で本格利用。
export function isSystemEventContextChanged(sessionKey: string, contextKey?: string): boolean;
```

#### ContextBuilder

```typescript
// src/assistant/context-builder.ts
//
// --- 責務境界 ---
// ContextBuilder は「動的コンテキスト」
// （イベント + メモリ + SystemEvent + セッショントランスクリプト直近窓）を組み立てる。
// 「静的ペルソナ」（SOUL.md / USER.md / AGENTS.md）は ContextBuilder の管轄外。
// 静的ペルソナは呼び出し元が直接読み込み、AgentRunOptions.systemPrompt に渡す。
// これにより ContextBuilder は純粋な「データ → プロンプトテキスト」変換に集中できる。
//
// --- フロー別の使い分け ---
// ハートビートフロー: events = EventReader 結果, systemEvents = 空, recentTranscript = 空
//   → HB が直接 EventReader を呼び、生イベントをコンテキストに含める
// チャットフロー:     events = 空,             systemEvents = SEQ drain(text[]) 結果, recentTranscript = SDK transcript 直近窓
//   → 呼び出し元（ChatHandler）が SEQ を drain し、SDK transcript 直近窓と合わせて ContextBuilder に渡す
// 両パラメータを同時に渡さないことで、イベント情報の重複注入を防ぐ。

export type ContextBuildOptions = {
  events: NormalizedEvent[]; // ハートビートフロー用（チャットフローでは空配列）
  systemEvents?: string[]; // チャットフロー用（drainSystemEvents の text[]）
  recentTranscript?: SessionTranscriptEvent[]; // FR-06: セッショントランスクリプト直近窓
  // raw/message からの表示・要約向け投影は ContextBuilder 側で行う
  memoryContent?: string; // MEMORY.md の内容
  dailyMemoryContent?: string; // memory/YYYY-MM-DD.md の内容 (today)
  yesterdayMemoryContent?: string; // memory/YYYY-MM-DD.md の内容 (yesterday)
  maxTokenEstimate?: number; // 概算トークン上限 (default: 8000)
};

export type ContextBuildResult = {
  text: string; // LLM プロンプトに挿入可能なテキストブロック
  truncated: boolean; // トークン上限による切り詰めが発生したか
  eventCount: number; // 含まれたイベント数
};

export function buildEventContext(opts: ContextBuildOptions): ContextBuildResult;
```

#### CommandQueue

```typescript
// src/assistant/command-queue.ts
// OpenClaw の CommandLane パターンを簡易実装。
// `main`（グローバル）+ `session:<sessionKey>`（セッション）レーンで
// エージェント実行を直列化し、同時実行・セッション混線を防ぐ。

export type CommandFn<T> = () => Promise<T>;

export type CommandQueueOptions = {
  lane?: string; // 省略時 "main"
};

export function resolveSessionLane(sessionKey: string): string; // "session:<sessionKey>"
export function enqueueCommandInLane<T>(lane: string, fn: CommandFn<T>): Promise<T>;
export function enqueueCommand<T>(fn: CommandFn<T>, opts?: CommandQueueOptions): Promise<T>;
export function getQueueSize(lane?: string): number; // 省略時 "main"
export function isIdle(lane?: string): boolean;
export function isGlobalIdle(): boolean; // 補助API（Heartbeat 判定は getQueueSize("main") を使用）
```

#### HeartbeatRunner

```typescript
// src/assistant/heartbeat-runner.ts
export type HeartbeatConfig = {
  intervalMs: number; // default: 1800000 (30m)
  timeoutMs?: number; // default: 30000 (§2.8: HB 1 回あたりの LLM タイムアウト上限)
  sessionKey?: string; // default: "main"（OpenClaw 解決規則で canonical 化）
  heartbeatFilePath: string; // default: "HEARTBEAT.md"
  soulFilePath: string; // default: "SOUL.md"
  userFilePath: string; // default: "USER.md"
  agentsFilePath: string; // default: "AGENTS.md"
  dataDir: string;
  userTimezone?: string; // default: agents.defaults.userTimezone（Current time 注入に使用）
  retryDelayMs?: number; // default: 1000 (requests-in-flight 時の短周期再試行)
  ackMaxChars: number; // default: 300 (HEARTBEAT_OK 判定閾値)
  // 可視性設定（showOk/showAlerts/useIndicator）は HeartbeatConfig では持たない。
  // OpenClaw 準拠で channels 設定から解決する:
  // channels.defaults.heartbeat
  // channels.<channel>.heartbeat
  // channels.<channel>.accounts.<accountId>.heartbeat
  // ※ channel が webchat の場合は OpenClaw と同様に channels.defaults.heartbeat のみ参照
  model?: string; // ハートビート用モデル（省略時はデフォルトモデル）
  // コスト最適化: 安価なモデルを指定可能
  activeHours?: {
    // アクティブ時間帯設定（省略時は常時有効）
    start: string; // 開始時刻 "HH:MM"（例: "09:00"）
    end: string; // 終了時刻 "HH:MM"（例: "22:00"、"24:00" 可。start > end で深夜跨ぎ）
    timezone?: string; // "user"（USER.md の timezone）| "local"（ホスト環境）| IANA タイムゾーン名
  }; // OpenClaw heartbeat-active-hours.ts 準拠
};

// HeartbeatRunResult は判別共用体（discriminated union）とする。
// status ごとに有効なフィールドが型で確定し、実装ミスを防ぐ。
export type HeartbeatRunResult =
  | {
      status: "ran";
      durationMs: number;
      alert?: string; // アラートテキスト（抑制時は undefined）
      contentHash?: string; // ログ・可観測性用（重複排除は lastHeartbeatText で行う）
      modelId?: string; // 使用モデル ID（コスト分析用）
    }
  | {
      status: "skipped";
      reason: string; // OpenClaw 準拠: alerts-disabled / readiness の詳細理由を含む
    }
  | {
      status: "failed";
      reason: string;
    };

// HeartbeatEventPayload は通知・抑制種別のイベントログ型。
// HeartbeatRunResult は「実行結果」、HeartbeatEventPayload は「通知/抑制の詳細ログ」として責務分離する。
// to, channel, accountId, hasMedia, silent は OpenClaw マルチチャネル通知との互換用。
// Adjutant MVP（Web UI のみ）では undefined のまま省略してよい。
export type HeartbeatEventPayload = {
  ts: number; // epoch ms
  status: "sent" | "ok-empty" | "ok-token" | "skipped" | "failed";
  reason?: string;
  to?: string;
  channel?: string;
  accountId?: string;
  preview?: string;
  durationMs?: number;
  hasMedia?: boolean;
  silent?: boolean;
  indicatorType?: "ok" | "alert" | "error";
};

// HeartbeatRunRecord は実行結果の監査用レコード。
// HeartbeatEventPayload（通知/抑制ログ）とは別に保存し、モデル呼び出し回数の追跡に使う。
export type HeartbeatRunRecord = {
  schema: "adjutant.heartbeat.result.v1";
  runAt: string; // ISO8601
  sessionId?: string;
  sessionKey?: string;
  result: HeartbeatRunResult;
  triggerReason?: string; // 実行トリガー理由（OpenClaw runHeartbeatOnce(reason) と整合）
  modelId?: string;
  preview?: string;
};

// --- 重複排除仕様 ---
// - キー: 直前送達テキスト（Session Entry `lastHeartbeatText`）
// - ウィンドウ: 24 時間（lastHeartbeatSentAt との差分で判定）
// - 保持: Session Entry `lastHeartbeatSentAt` とともに
//         OpenClaw 互換の Session Entry Store（例: `sessions.json`）へ永続化する
//         （表示用の投影層には保持しない）
// - 判定タイミング: stripHeartbeatToken() 後、UI 送信前
//   → モデルは呼び出し済みのため HeartbeatRunResult { status: "ran", durationMs: ... } を返し、
//     HeartbeatEventPayload でも status: "skipped", reason: "duplicate" を記録
//   （OpenClaw heartbeat-runner.ts:646 準拠: 重複検出時も status: "ran"）
//
// --- Current time 注入仕様 ---
// Heartbeat 実行時の送信 Body 末尾に以下の1行を注入する（時刻依存判断の安定化）:
//   Current time: <formattedTime> (<userTimezone>)
// 送信 Body にすでに "Current time:" 行が含まれる場合、同一実行で重複挿入しない。
// userTimezone は `agents.defaults.userTimezone`（未設定時はホスト環境）から解決する。
// （OpenClaw heartbeat-runner.ts 準拠）
//
// --- requests-in-flight 再試行仕様 ---
// - requests-in-flight で skipped になった場合は、そのまま次周期待ちにせず短時間で再試行する
// - 既定再試行間隔: retryDelayMs=1000ms
// - 再試行上限は設けず、wake ハンドラが coalesce/retry を管理する（OpenClaw heartbeat-wake.ts 準拠）

// --- stripHeartbeatToken 仕様 ---
// HEARTBEAT_OK トークンの検出時、以下のマークアップ正規化を事前に行う
// （OpenClaw heartbeat.ts:121-129 準拠）:
//   1. HTML タグを除去 (<b>HEARTBEAT_OK</b> → HEARTBEAT_OK)
//   2. &nbsp; を空白に変換
//   3. 先頭・末尾の Markdown 修飾文字 (*`~_) を除去 (**HEARTBEAT_OK** → HEARTBEAT_OK)
// 正規化後のテキストから HEARTBEAT_OK を先頭/末尾で繰り返し除去し、
// 残テキストが ackMaxChars 以下なら shouldSkip=true とする。
//
// --- 可視性設定 ---
// channels から解決された showOk / showAlerts / useIndicator がすべて false の場合は、
// Heartbeat 自体を実行しない（モデル呼び出しなし）。

export function startHeartbeat(config: HeartbeatConfig): { stop: () => void };
// 手動 heartbeat 実行（POST /api/heartbeat/run）向けの単発実行 API。
// runHeartbeatOnce(reason) の公開契約。
export function runOnce(
  config: HeartbeatConfig,
  opts?: { reason?: string }
): Promise<HeartbeatRunResult>;
export function onHeartbeatEvent(listener: (evt: HeartbeatEventPayload) => void): () => void;
export function getLastHeartbeatEvent(): HeartbeatEventPayload | null;
```

#### AgentRunner

AgentRunner は以下のサブ要件を満たす。各要件は受け入れ条件と対応する。

| サブ要件    | 内容                                                                                       | 対応 AC       |
| ----------- | ------------------------------------------------------------------------------------------ | ------------- |
| **FR-AG-1** | OpenClaw 準拠の SDK 利用手順（下記 6 ステップ）を遵守する                                  | AC-03         |
| **FR-AG-2** | 最終回答と途中イベント（ツール実行・推論メタ情報）を分離し、部分応答の順序保証を行う       | AC-14 / AC-19 |
| **FR-AG-3** | 一時失敗（通信/HTTP 系）は 2.5 秒待機後に 1 回再試行。コンテキスト超過時は切り詰めて再試行 | AC-06         |
| **FR-AG-4** | セッションファイル破損を検知し修復/退避できる設計とする                                    | AC-03         |

```typescript
// src/assistant/agent-runner.ts
// pi-coding-agent の createAgentSession / activeSession.prompt を使用。
//
// --- FR-AG-1: SDK 利用手順（OpenClaw 規範実装に準拠）---
// 実行フローは以下の順序を満たすこと:
//   1. セッションファイルの排他ロックを取得する
//      （同一セッションファイルへの同時書き込み防止。CommandQueue の論理排他とは別層の物理防御）
//   2. セッションファイルの修復/事前準備を行い、SessionManager を開く（既存セッション再利用 or 新規作成）
//   3. SettingsManager を生成（モデル・ツール等の実行設定を反映）
//   4. createAgentSession で実行セッションを構築
//   5. 購読層でストリーミングイベントを受け取り、UI 向けに整形（FR-AG-2）
//   6. 実行終了時にセッションを確定・解放
// 例外発生時もセッション後処理（flush/dispose + ロック解放）を finally 相当で必須とする（FR-AG-4）。
//
// 参照: vendor/openclaw/src/agents/pi-embedded-runner/run/attempt.ts

export type AgentRunOptions = {
  runId: string; // OpenClaw chat.send 準拠で idempotencyKey を runId として使用する。
  //   2 段 API パターン: POST レスポンスで runId(=idempotencyKey) を返却後、
  //   CQ にエンキューされたタスク内で AgentRunner に渡す。
  //   SSE ストリームのルーティングに使用する。
  prompt: string;
  systemPrompt?: string; // 静的ペルソナ（SOUL.md + USER.md + AGENTS.md を結合したテキスト）。
  //   呼び出し元が読み込み・結合して渡す。ContextBuilder の管轄外。
  //   SDK の system prompt として LLM に送信される。
  sessionKey: string;
  sessionId?: string; // UI 表示用の会話ID（必要時）
  isHeartbeat?: boolean; // true の場合:
  //   - OpenClaw 準拠で suppress 系の経路では updatedAt を復元する
  //     （ok-token / ok-empty / duplicate / alerts-disabled など）
  //     通知送信経路では updatedAt が更新されうる
  //   - memory_write ツールを無効化（メモリ書き込みガード）
  model?: string; // 使用する LLM モデル（省略時はデフォルトモデル）。
  //   HeartbeatRunner がモデルカスケード設定（HeartbeatConfig.model）を
  //   ここに渡すことで、安価なモデルでの実行が可能になる。
  //   SettingsManager 生成時に反映される。
  onTextDelta?: (delta: string) => void;
  onToolCall?: (name: string, params: unknown) => void;
};

export type AgentRunResult = {
  runId: string; // AgentRunOptions.runId をそのまま返す（呼び出し元との紐付け用）
  text: string;
  toolCalls?: Array<{ name: string; result: unknown }>;
};

export function runAgent(opts: AgentRunOptions): Promise<AgentRunResult>;
```

#### MemoryReader

```typescript
// src/assistant/memory-reader.ts
// メモリファイルの読み込みを担当。ContextBuilder へのメモリ注入に使用する。

export type MemoryReadOptions = {
  workspaceDir: string;
  timezone: string; // default: USER.md の timezone / 未設定時はホスト環境
};

export function readMemoryFiles(opts: MemoryReadOptions): Promise<{
  longTerm: string | null; // MEMORY.md
  daily: string | null; // memory/YYYY-MM-DD.md (today)
  yesterday: string | null; // memory/YYYY-MM-DD.md (yesterday)
}>;
```

#### MemoryWriter

```typescript
// src/assistant/memory-writer.ts
// エージェントのツールとして登録し、AI が判断して書き出す。

export type MemoryWriteOptions = {
  workspaceDir: string;
  timezone: string; // default: USER.md の timezone / 未設定時はホスト環境
};

// memory/YYYY-MM-DD.md に追記
export function appendDailyMemory(content: string, opts: MemoryWriteOptions): Promise<void>;

// MEMORY.md を更新（上書き）
export function updateLongTermMemory(content: string, opts: MemoryWriteOptions): Promise<void>;
```

#### TranscriptReader（SDKトランスクリプト投影）

```typescript
// src/assistant/transcript-reader.ts
// OpenClaw 準拠: SDK トランスクリプト JSONL と Session Entry Store(`sessions.json`)を読み取り、
// UI 表示/直近窓注入向けに投影する。独立した表示専用ログストアは持たない。
//
// ⚠️ セッション管理の正（source of truth）は pi-coding-agent SDK が担う。
// 本モジュールは SDK 永続化データの読み取り専用であり、
// UI でのメッセージ一覧表示・タイムスタンプ表示・直近窓抽出に使用する。
// SDK セッションの復元・コンパクション・ツール状態管理は SDK に委譲する。

// Pi transcript JSONL の 1 行（生データ）。OpenClaw では `message` を持つ行が会話履歴になる。
// それ以外に header/compaction などの行も含まれるため、生形式のまま保持できる型にする。
export type PiTranscriptLine = {
  type?: string;
  timestamp?: string;
  message?: Record<string, unknown>;
  id?: string;
  [key: string]: unknown;
};

// SessionTranscriptEvent は「生行」から抽出した読み取り時の投影モデル。
// 永続化フォーマット自体を再定義しない（source of truth は SDK transcript JSONL）。
export type SessionTranscriptEvent = {
  sessionKey: string;
  sessionId: string;
  messageId?: string;
  ts: number; // epoch ms
  role: "user" | "assistant" | "system" | "tool" | "other";
  text?: string;
  raw: PiTranscriptLine;
};

// UI 表示向けの簡易モデル（OpenClaw chat.history の messages 配列を扱いやすく投影）。
export type SessionMessage = {
  role: "user" | "assistant" | "system" | "tool" | "other";
  content: string;
  timestamp: number;
  message?: Record<string, unknown>; // 元の message オブジェクト
};

export type TranscriptReadOptions = {
  sessionKey: string;
  limit?: number;
};

export function loadRecentSessionEvents(
  opts: TranscriptReadOptions & { limit: number }
): Promise<SessionTranscriptEvent[]>;
// OpenClaw chat.history 互換で sanitized message objects を返す。
export function loadMessages(opts: TranscriptReadOptions): Promise<unknown[]>;
```

#### API Server

```typescript
// src/assistant/api-server.ts
//
// assistant-ui との統合を考慮し、メッセージ送信（POST）と
// ストリーミング取得（GET SSE）を分離する 2 段パターンを採用する。
// これにより assistant-ui の useExternalStoreRuntime や
// カスタム Runtime との接続が容易になる。

// --- チャット ---

// POST /api/chat/messages — ユーザーメッセージ送信、run を作成
// Request:  { message: string, sessionKey: string, idempotencyKey: string }
// Response: { runId: string, status: "started" | "in_flight" | "ok" | "error", summary?: string }
//   → コマンドキュー経由で直列化。run は非同期で実行開始される。
//   → runId は idempotencyKey をそのまま使用する（OpenClaw chat.send 準拠）。
//   → idempotencyKey は冪等キー。同一 idempotencyKey の再送は
//     冪等 TTL（既定 300 秒）内で既存 run の状態（in_flight/ok/error）を返し、新規キュー投入しない。
//   → sessionKey が未指定/空文字の場合は 400 Bad Request。
//   → message が stop トリガー（例: "/stop"）の場合は新規 run を作らず、
//     sessionKey の実行中 run を abort して {ok, aborted, runIds} を返す。
//
// POST /api/chat/abort — 実行中 run のキャンセル（OpenClaw chat.abort 準拠）
// Request:  { sessionKey: string, runId?: string }
// Response: { ok: true, aborted: boolean, runIds: string[] }
//   - runId 指定時: 対象 run のみキャンセル
//   - runId 省略時: sessionKey の実行中 run を全件キャンセル

// GET /api/chat/runs/:runId/stream — 指定 run の SSE ストリーム
// Response: SSE stream (text/event-stream)
//   event: chat data: {
//     runId: string;
//     sessionKey: string;
//     seq: number;
//     state: "delta" | "final" | "aborted" | "error";
//     message?: unknown;
//     errorMessage?: string;
//     usage?: unknown;
//     stopReason?: string;
//   }
//
// --- 内部→公開 SSE 変換ルール（OpenClaw 実装方式に準拠）---
// pi-coding-agent SDK の内部イベントを公開 SSE へ変換する規則:
//   stream: "assistant" の増分                → state: "delta"
//   stream: "lifecycle", phase: "end"         → state: "final"
//   stream: "lifecycle", phase: "error"       → state: "error"
//   chat.abort API / stop トリガー            → state: "aborted"
// run 開始通知は POST /api/chat/messages のレスポンス（status: "started"）で扱う。
// tool stream は chat SSE に混在させず、必要時は別イベント系（将来拡張）で扱う。
//
// --- seq 連番 ---
// chat payload の seq は runId ごとに単調増加（OpenClaw schema は integer >= 0）。
// 通常の chat.send 実行では 1 始まり。
// OpenClaw 互換予約として chat.inject 相当の合成 final は seq=0 を許容するが、
// MVP では chat.inject エンドポイント自体は公開しない。
// これとは別に、SSE event frame 側の seq は optional。
// broadcast 配信時はグローバル seq を付与し、targeted 配信では省略を許容する。
// クライアントは両者の欠落・逆転を検知して順序保証の確認に使用できる。
//
// --- run 終了 ---
// 終端 state は "final" | "aborted" | "error" のいずれか 1 回のみ送信する。
// 重複終端を検出した場合、2 件目以降は公開 SSE へ送らず内部診断ログに記録する。
// state: "delta" は本文増分であり、終端判定には使わない。
// 終端 state 送信後、サーバーは SSE 接続を閉じる。
//
// --- keepalive ---
// サーバーは 15 秒間隔で SSE コメント行（`: ping\n\n`）を送信する。
// クライアントはコメント行を無視してよい（OpenClaw signal/client.ts 準拠）。
//
// --- 再接続ポリシー ---
// クライアントは接続断時に指数バックオフで再接続を試行する。
// （OpenClaw reconnect.ts 準拠: initial=2s, max=30s, factor=1.8, jitter=25%, maxAttempts=12）
// 再接続後、run が既に完了していた場合は終端 state を即送信して閉じる。
//
// --- stream 未接続時 ---
// クライアントが SSE 接続する前に run が完了した場合、
// 接続時に完了済みの終端 state を即座に送信して閉じる。結果は SDK トランスクリプトにも記録済み。
//
// --- 順序保証 ---
// SSE は HTTP/1.1 単一接続で送信順 = 受信順が保証される。
// broadcast される SSE event frame にはグローバル seq を付与し、送信順序の検証を可能にする。
// targeted 送信される event frame は seq 省略を許容する（OpenClaw server-broadcast.ts 準拠）。
// chat payload 内の seq は runId 単位の連番として扱う。
// 同一セッション内のイベントは、SDK トランスクリプトへの保存順と UI 表示順が一致すること。

// --- ハートビート ---

// POST /api/heartbeat/run — Heartbeat 実行（手動/定期）
// Request:  { reason?: string }  // 例: "manual" | "scheduled"
// Response: HeartbeatRunResult
//
// GET /api/events/stream — 共通イベント SSE（OpenClaw の event payload semantics に準拠。transport は HTTP/SSE）
// Response: SSE stream (text/event-stream)
//   event: heartbeat
//   data: HeartbeatEventPayload
//
// GET /api/heartbeat/last — 最新ハートビート結果取得（スナップショット）
// Response: HeartbeatEventPayload | null
//   - プロセス内で最後に emit された heartbeat イベントを返す（セッション固定ではない）
//   - UI 初期表示や events SSE 再接続時の復元に使用する
//   - sessionKey 指定での取得は MVP 対象外（将来拡張）
//
// GET /api/chat/history?sessionKey=... — 表示用履歴取得
// Response: {
//   sessionKey: string;
//   sessionId?: string;
//   messages: unknown[];      // OpenClaw chat.history 準拠（sanitized transcript message objects）
//   thinkingLevel?: string;
//   verboseLevel?: string;
// }
```

### 4.2 データモデル

既存の `NormalizedEvent` (`src/core/events.ts`) をそのまま使用する。
新規の型定義は `SessionTranscriptEvent` / `SessionMessage`、`SystemEvent`、`SystemEventEnqueueOptions`、`HeartbeatRunResult`、`HeartbeatEventPayload`、`HeartbeatRunRecord`、`ContextBuildResult`、`StreamEvent` など最小限に留める。

#### StreamEvent（SSE 公開イベント型）

```typescript
// OpenClaw chat イベント契約（state ベース）に合わせる。
type StreamEvent = {
  runId: string;
  sessionKey: string;
  seq: number; // integer >= 0（通常 run は 1 始まり。chat.inject 互換予約では 0 を許容）
  state: "delta" | "final" | "aborted" | "error";
  message?: unknown; // assistant message payload（delta/final）
  errorMessage?: string; // error 時の要約
  usage?: unknown;
  stopReason?: string; // aborted 時など
};
```

#### AgentRunStatus（実行状態の記録用）

```typescript
// 可観測性（§2.7）で求められる run 状態遷移のログ記録に使用する型。
// 永続化対象: SDK transcript / sessions.json / 診断ログ。
export type AgentRunStatus = {
  schema: "adjutant.agent.run-status.v1";
  sessionId: string;
  sessionKey: string;
  runId: string;
  status: "queued" | "running" | "completed" | "failed";
  reason?: string; // failed 時の理由
  updatedAt: string; // ISO8601
};
```

### 4.3 エラーと例外

| エラー                                                         | 対応                                                                                                                                                        |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JSONL ファイル不在                                             | 空配列を返す（エラーにしない）                                                                                                                              |
| LLM API 一時エラー（通信/HTTP 系）                             | 2.5 秒待機後にリトライ 1 回（OpenClaw 準拠）、失敗時は `state: "error"` を SSE で返す                                                                       |
| LLM コンテキスト超過エラー                                     | イベント/履歴入力を新しい順に切り詰めて再試行（1 回）。再試行も失敗時はエラーを返す                                                                         |
| LLM モデル利用不可                                             | 即座に失敗を返す。フォールバックモデルへの切り替えは将来拡張                                                                                                |
| HEARTBEAT.md 不在                                              | デフォルトプロンプトで実行（OpenClaw と同様）                                                                                                               |
| SOUL.md 不在                                                   | デフォルトのペルソナで動作                                                                                                                                  |
| USER.md 不在                                                   | ユーザー情報なしで動作（デフォルト設定）                                                                                                                    |
| AGENTS.md 不在                                                 | 追加の運用ルールなしで動作（デフォルト設定）                                                                                                                |
| MEMORY.md 不在                                                 | メモリなしで動作（初回起動時）                                                                                                                              |
| SDK トランスクリプト JSONL 破損                                | 読める行だけ読み込み、破損行はスキップ。破損検知をログに記録する                                                                                            |
| SDK セッションファイル破損（pi-coding-agent トランスクリプト） | SessionManager open 前に修復/事前準備を試行する（FR-AG-4 準拠）。修復不能な場合はセッションファイルを退避（rename）して新規作成で復旧。破損検知をログに記録 |
| SDK セッション解放失敗                                         | 例外発生時も finally で flush/dispose + ロック解放を実行。失敗をログに記録                                                                                  |

### 4.4 代表的な例

**チャット API リクエスト（2段パターン）:**

```bash
# Step 1: メッセージ送信 → runId 取得
curl -X POST http://localhost:3100/api/chat/messages \
  -H "Content-Type: application/json" \
  -d '{"message":"今日の #general で何が話されてた？","sessionKey":"main","idempotencyKey":"msg_001"}'
# Response: {"runId":"msg_001","status":"started"}

# Step 2: runId で SSE ストリーム接続
curl -N http://localhost:3100/api/chat/runs/msg_001/stream
```

**SSE レスポンス:**

```
event: chat
data: {"runId":"msg_001","sessionKey":"main","seq":1,"state":"delta","message":{"role":"assistant","content":[{"type":"text","text":"今日の #general では主に"}],"timestamp":1739600000000}}

event: chat
data: {"runId":"msg_001","sessionKey":"main","seq":2,"state":"delta","message":{"role":"assistant","content":[{"type":"text","text":"3つのトピックが議論されていました..."}],"timestamp":1739600000500}}

event: chat
data: {"runId":"msg_001","sessionKey":"main","seq":3,"state":"final","message":{"role":"assistant","content":[{"type":"text","text":"今日の #general では主に3つのトピックが議論されていました..."}],"timestamp":1739600001200}}
```

**HEARTBEAT.md の例:**

```markdown
# Heartbeat Checklist

- 自分宛のメンション (@masahide) があれば教えて
- #incident チャンネルに新しい投稿があればサマリーを出して
- リアクションが5個以上ついたメッセージがあれば教えて
```

**SOUL.md の例:**

```markdown
# Adjutant AI Assistant

あなたは Adjutant の AI アシスタントです。

## 基本方針

- 簡潔に、要点を絞って回答する
- Slack のチャンネル名やユーザー名は可能な限り解決して表示する
- 日本語で応答する

## ハートビート時の振る舞い

- 緊急度の高いものを優先して通知する
- 同じ内容を繰り返し通知しない
- 通知は短く（3行以内）、詳細はユーザーに聞かれてから答える

## メモリ管理

- ユーザーが「覚えておいて」と言った情報は memory/YYYY-MM-DD.md に記録する
- 重要な長期的事実（プロジェクト名、チームメンバー、好み）は、ユーザーの明示指示がある場合のみ MEMORY.md に記録する
```

**USER.md の例:**

```markdown
# User Profile

## 基本情報

- 名前: masahide
- Slack表示名: @masahide
- 所属チーム: Platform Engineering
- タイムゾーン: Asia/Tokyo（例）

## 関心のあるチャンネル

- #incident（障害対応）
- #platform-eng（チーム）
- #general（全社）

## 好み・指示

- 技術的な内容は詳細に、それ以外は簡潔に
- 障害関連は最優先で通知してほしい
```

---

## 5. アーキテクチャ

### 5.1 コンポーネント図

```mermaid
graph TD
    subgraph "既存 (変更なし)"
        CDP[Slack CDP] --> SA[SlackAdapter]
        SA --> JW[JsonlWriter]
        JW --> JSONL[(data/YYYY/MM/DD/<br/>slack/events.jsonl)]
    end

    subgraph "新規: Backend (src/assistant/)"
        JSONL --> ER[EventReader]
        ER --> CB[ContextBuilder]
        SEQ[SystemEventQueue] --> CB
        MEM[(MEMORY.md<br/>memory/YYYY-MM-DD.md)] --> MR[MemoryReader]
        MR --> CB
        CB --> AR[AgentRunner]
        HB[HeartbeatRunner] -. "queue size check" .-> CQ[CommandQueue]
        HB --> AR
        API[API Server :3100] --> CQ
        CQ --> AR
        AR --> SDK["pi-coding-agent SDK"]
        SDK --> LLM[Anthropic Claude]
        AR --> MW[MemoryWriter]
        MW --> MEM
        API --> TR[TranscriptReader]
        TR --> SESS[(sessions.json +<br/>session transcript JSONL)]
        SDK --> SESS
    end

    subgraph "新規: Frontend (src/ui/)"
        UI["assistant-ui<br/>React App"] --> API
    end

    subgraph "ワークスペースファイル"
        SOUL[SOUL.md]
        USER[USER.md]
        AGENTS[AGENTS.md]
        HBMD[HEARTBEAT.md]
    end

    SOUL -. "systemPrompt" .-> AR
    USER -. "systemPrompt" .-> AR
    AGENTS -. "systemPrompt" .-> AR
    HBMD --> HB
    HB -- "heartbeat event" --> API
    API -- "SSE: chat stream / heartbeat" --> UI
```

### 5.2 ハートビートシーケンス図

```mermaid
sequenceDiagram
    participant Timer as HeartbeatRunner
    participant CQ as CommandQueue
    participant ER as EventReader
    participant CB as ContextBuilder
    participant MR as MemoryReader
    participant AR as AgentRunner
    participant LLM as Claude API
    participant SEQ as SystemEventQueue
    participant API as API Server
    participant UI as assistant-ui

    Timer->>Timer: intervalMs 経過

    alt activeHours 設定あり & 時間外
        Timer->>Timer: skip (quiet-hours)
    else activeHours 未設定 or 時間内
        Timer->>CQ: getQueueSize("main")

    alt main レーンがビジー
        Timer->>Timer: skip (requests-in-flight)
        Timer->>Timer: heartbeat-wake が 1 秒後に再試行
    else main レーンがアイドル
        Timer->>Timer: runHeartbeatOnce(reason)

        Note over Timer,AR: ── HeartbeatRunner 本体内で実行 ──

        Timer->>Timer: read HEARTBEAT.md
        alt HEARTBEAT.md が実質空
            Timer->>Timer: skip (empty-heartbeat-file)
        else
            Timer->>ER: readEvents(today)
            ER-->>Timer: NormalizedEvent[]
            Timer->>MR: readMemoryFiles()
            MR-->>Timer: {longTerm, daily, yesterday}
            Timer->>CB: buildEventContext(events + memory)
            CB-->>Timer: contextText

            Timer->>AR: run(heartbeatPrompt + contextText, systemPrompt, isHeartbeat=true)
            AR->>LLM: stream request
            LLM-->>AR: response
            AR-->>Timer: AgentRunResult

            alt response が HEARTBEAT_OK / 実質空
                Timer->>Timer: stripHeartbeatToken → suppress
                Timer->>API: emitHeartbeatEvent(status="ok-token" | "ok-empty")
            else 配信対象なし/抑制（duplicate, alerts-disabled, readiness-failed など）
                Timer->>API: emitHeartbeatEvent(status="skipped")
            else 配信あり
                Note over Timer,SEQ: HeartbeatRunner は SystemEventQueue へ enqueue しない（OpenClaw 準拠）
                Timer->>API: emitHeartbeatEvent(status="sent")
            end
            API->>UI: SSE event: heartbeat
        end
    end
    end
```

### 5.3 チャットシーケンス図

```mermaid
sequenceDiagram
    participant User
    participant UI as assistant-ui
    participant API as API Server
    participant CQ as CommandQueue
    participant SEQ as SystemEventQueue
    participant CB as ContextBuilder
    participant MR as MemoryReader
    participant AR as AgentRunner
    participant LLM as Claude API
    participant TR as TranscriptReader

    User->>UI: メッセージ入力
    UI->>API: POST /api/chat/messages {message, sessionKey, idempotencyKey}

    Note over API: runId=idempotencyKey で冪等判定

    API->>CQ: enqueueCommandInLane(resolveSessionLane(sessionKey), () => enqueueCommand(chatTask))
    API-->>UI: {runId, status}
    UI->>API: GET /api/chat/runs/:runId/stream

    Note over API,AR: ── 以下は enqueue されたタスク関数内（sessionKey 単位で直列実行）──

    API->>SEQ: drain(sessionKey)
    SEQ-->>API: string[] (system event texts)
    API->>MR: readMemoryFiles()
    MR-->>API: {longTerm, daily, yesterday}
    API->>TR: loadRecentSessionEvents(sessionKey, limit)
    TR-->>API: SessionTranscriptEvent[] (recent)
    API->>CB: buildEventContext(systemEvents + memory + recentTranscript)
    CB-->>API: contextText
    API->>AR: run(userText + contextText, systemPrompt)
    AR->>LLM: stream request
    loop streaming
        LLM-->>AR: assistant delta
        AR-->>API: chat state=delta
        API-->>UI: SSE chat {runId, sessionKey, seq, state:"delta"}
        UI-->>User: リアルタイム表示
    end
    alt 正常完了
        LLM-->>AR: lifecycle end
        AR-->>API: chat state=final
        API-->>UI: SSE chat {runId, sessionKey, seq, state:"final"}
    else 中断
        AR-->>API: chat state=aborted
        API-->>UI: SSE chat {runId, sessionKey, seq, state:"aborted", stopReason}
    else 失敗
        AR-->>API: chat state=error
        API-->>UI: SSE chat {runId, sessionKey, seq, state:"error", errorMessage}
    end
    Note over AR: SDK SessionManager が transcript JSONL を永続化
```

### 5.4 メモリ読み書きフロー

```mermaid
flowchart TD
    A["エージェント実行中"] --> B{"ユーザーの明示指示があるか"}
    B -->|"はい（例: 覚えておいて）"| C["memory_write ツール呼び出し"]
    B -->|"いいえ"| D["通常応答"]
    C --> E{"書き込み先"}
    E -->|"日次メモ"| F["memory/YYYY-MM-DD.md に追記"]
    E -->|"長期記憶"| G["MEMORY.md を更新"]
    F --> H["次回プロンプトで自動読み込み"]
    G --> H

    I["次回エージェント起動"] --> J["MEMORY.md 読み込み"]
    J --> K["memory/今日.md + memory/昨日.md 読み込み"]
    K --> L["コンテキストに注入"]
    L --> M["AI が文脈を保持して応答"]
```

### 5.5 コマンドキュー状態遷移図

```mermaid
stateDiagram-v2
    [*] --> Idle

    Idle --> Processing: ユーザーメッセージ受信
    Idle --> HeartbeatRunning: ハートビート発火 (getQueueSize(main)=0)
    Idle --> Idle: ハートビート発火 (getQueueSize(main)>0 → requests-in-flight)
    HeartbeatRunning --> Idle: Heartbeat 実行完了 (ran/skipped/failed)

    note right of Idle : MVP では Heartbeat 実行前に\nmain レーン混雑度を getQueueSize(main) で判定する。\nHeartbeat は CommandQueue 非経由で実行する。

    Processing --> ContextBuilding: コマンドdequeue
    ContextBuilding --> AgentRunning: コンテキスト構築完了
    AgentRunning --> ToolExecution: ツール呼び出し (memory_write等)
    ToolExecution --> AgentRunning: ツール結果返却
    AgentRunning --> SessionSave: 応答完了
    SessionSave --> Idle: セッション保存完了

    Processing --> Processing: 追加メッセージ → キューに積む
```

---

## 6. テスト戦略

### 6.1 テストの種類

| 種類        | 対象             | 方針                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit        | EventReader      | JSONL パース、日付フィルタ、sinceMinutes/limit 切り詰め、空ファイル処理                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Unit        | SystemEventQueue | enqueue/drain/peek、MAX_EVENTS=20 上限、sessionKey 分離、連続重複排除、contextKey 変化検知、drain 後の cleanup                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Unit        | ContextBuilder   | トークン切り詰め、truncated フラグ、メモリ注入、SystemEvent 注入、フォーマット出力                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Unit        | CommandQueue     | main レーン + session レーン二段直列化、getQueueSize/isIdle 判定                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Unit        | HeartbeatRunner  | タイマー制御、HEARTBEAT_OK 判定（stripHeartbeatToken + マークアップ正規化）、空ファイルスキップ（実質空判定）、requests-in-flight/quiet-hours/alerts-disabled/readiness-failed スキップ、requests-in-flight 短周期再試行、`heartbeat.session` 解決（無効/他 agent 指定時の main フォールバック）、重複排除（`lastHeartbeatText` + `lastHeartbeatSentAt`、24h）、modelId 記録、Current time 注入（重複防止含む）、可視性設定（`channels.defaults.heartbeat`/`channels.<channel>.heartbeat`/`channels.<channel>.accounts.<id>.heartbeat`） |
| Unit        | MemoryReader     | timezone に基づく today/yesterday 日付計算、ファイル不在時の null 返却、正常読み込み                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Unit        | MemoryWriter     | ファイル追記・更新、日付パーティション                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Unit        | TranscriptReader | SDK transcript JSONL + Session Entry Store（`sessions.json`）からの読み取り、必須項目投影、破損行スキップ、loadMessages/loadRecentSessionEvents                                                                                                                                                                                                                                                                                                                                                                                          |
| Unit        | AgentRunner      | メモリ書き込みガード（明示トリガーありで memory_write 実行 / 明示トリガーなしで不実行 / ハートビート時は常に除外）、メモリ保存内容の次回ターン再利用、SDK セッション後処理（例外時 flush/dispose）、コンテキスト超過時の切り詰め再試行                                                                                                                                                                                                                                                                                                   |
| Integration | API Server       | 2 段パターン（POST → runId → GET SSE）、chat.abort 契約（run 単位 / sessionKey 全件）、seq 連番検証（event frame: broadcast 時はグローバル単調増加・targeted は optional / chat payload: `integer >= 0` かつ runId 単位単調増加）、終端 state 一意保証（`final`/`aborted`/`error`）、delta 0 件ケースでの `final.message` 表示保証、idempotencyKey 冪等性（runId=idempotencyKey）、SSE keepalive/reconnect、`event: heartbeat` push + `last` スナップショット、エラーレスポンス                                                          |
| Contract    | NormalizedEvent  | 既存スキーマとの整合性                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

### 6.2 モック境界

- LLM API 呼び出し → モック（テストで実 API を叩かない）
- JSONL ファイル読み込み → テスト用フィクスチャファイル
- タイマー → `node:timers/promises` の mock
- ファイルシステム（メモリ書き出し） → テスト用 tmpdir

---

## 7. 実装タスクリスト

### Phase 1: 基盤準備

- [ ] 要件定義レビュー・確定
- [ ] `package.json` に `"assistant"` スクリプトを追加（P-01 前提）
- [ ] pi-coding-agent SDK の依存追加と接続確認
- [ ] assistant-ui 基盤セットアップ（Vite + React）
- [ ] HEARTBEAT.md テンプレート作成
- [ ] SOUL.md テンプレート作成
- [ ] USER.md / AGENTS.md テンプレート作成

### Phase 2: EventReader + SystemEventQueue

- [ ] Test: JSONL 読み込みの失敗テスト作成 (Red)
- [ ] Impl: `readEvents()` 実装 (Green)
- [ ] Test: SystemEventQueue の enqueue/drain テスト (Red)
- [ ] Impl: SystemEventQueue 実装 (Green)
- [ ] Refactor: フィルタオプション整理

### Phase 3: ContextBuilder + MemoryReader + MemoryWriter

- [ ] Test: イベント配列 → プロンプトテキスト変換テスト (Red)
- [ ] Impl: `buildEventContext()` 実装 (Green)
- [ ] Test: メモリ注入、SystemEvent 注入テスト (Red)
- [ ] Impl: メモリ・SystemEvent コンテキスト統合 (Green)
- [ ] Test: MemoryReader timezone 日付計算・ファイル不在時 null 返却テスト (Red)
- [ ] Impl: `readMemoryFiles()` 実装 (Green)
- [ ] Test: MemoryWriter ファイル追記テスト (Red)
- [ ] Impl: `appendDailyMemory()` / `updateLongTermMemory()` 実装 (Green)
- [ ] Refactor: トークン概算と切り詰めロジック

### Phase 4: CommandQueue + HeartbeatRunner

- [ ] Test: CommandQueue main レーン + session レーンの二段直列化テスト (Red)
- [ ] Impl: CommandQueue 実装（enqueueCommandInLane + resolveSessionLane + getQueueSize(main) 判定）(Green)
- [ ] Test: HeartbeatRunner タイマー発火テスト (Red)
- [ ] Impl: `startHeartbeat()` 実装 (Green)
- [ ] Test: HEARTBEAT_OK 判定、空ファイルスキップ、requests-in-flight テスト (Red)
- [ ] Test: requests-in-flight 時の短周期再試行テスト (Red)
- [ ] Test: `heartbeat.session` に無効/他 agent セッションを指定した場合、main セッションへフォールバックするテスト (Red)
- [ ] Test: readiness 失敗時に `status: "skipped"` とイベントログ `status: "skipped"` が記録されるテスト (Red)
- [ ] Test: `ok-token`/`ok-empty` の可視化判定側 readiness 失敗では `ran + ok-*` を維持するテスト (Red)
- [ ] Test: channels heartbeat 可視性（showOk/showAlerts/useIndicator）全false時のモデル呼び出しなしテスト (Red)
- [ ] Test: 重複排除（24h ウィンドウ + `lastHeartbeatText/lastHeartbeatSentAt`、ウィンドウ期限切れ後の再通知）(Red)
- [ ] Test: Current time 注入テスト — Body 末尾に時刻行が付与され、既存時は重複挿入しない (Red)
- [ ] Impl: stripHeartbeatToken、スキップロジック、重複排除、Current time 注入実装 (Green)
- [ ] Refactor: OpenClaw パターンとの整合確認

### Phase 5: TranscriptReader + AgentRunner

- [ ] Test: SDK transcript + `sessions.json` の読み取り/投影テスト（破損行スキップ含む）(Red)
- [ ] Impl: TranscriptReader 実装 (Green)
- [ ] Test: LLM ストリーミングのモックテスト (Red)
- [ ] Test: セッショントランスクリプト直近窓が入力コンテキストへ注入されるテスト (Red)
- [ ] Impl: AgentRunner 実装（SDK 利用手順: SessionManager → SettingsManager → createAgentSession → subscribe → dispose）(Green)
- [ ] Test: メモリ書き込みガード — 明示トリガーありで memory_write が実行されるテスト (Red)
- [ ] Test: メモリ書き込みガード — 明示トリガーなしでは memory_write が実行されないテスト (Red)
- [ ] Test: メモリ再利用 — memory_write で保存した内容が次回ターンの入力コンテキストへ再注入されるテスト (Red)
- [ ] Test: SDK セッション後処理テスト — 例外発生時も flush/dispose が確実に実行される (Red)
- [ ] Test: コンテキスト超過時の切り詰め再試行テスト (Red)
- [ ] Impl: 失敗回復ロジック（1 回再試行 + 切り詰め再試行）(Green)
- [ ] Impl: memory_write ツール登録 + 明示トリガー判定実装 (Green)
- [ ] Integration: AgentRunner + TranscriptReader + MemoryWriter 結合テスト

### Phase 6: API Server

- [ ] Test: 2 段パターン（POST → runId → GET SSE）基本フローテスト (Red)
- [ ] Test: POST /api/chat/messages が `status: "started"` を返す契約テスト (Red)
- [ ] Test: idempotencyKey 冪等性テスト — TTL 内再送で既存 runId の状態を返却 (Red)
- [ ] Test: SSE seq 連番（broadcast frame）・targeted frame の seq optional・終端 state 一意保証（`final`/`aborted`/`error`）テスト (Red)
- [ ] Test: `state: "delta"` 0 件ケースでも `state: "final"` の `message` で本文表示を更新できるテスト (Red)
- [ ] Test: OpenClaw 方式の chat state 変換（`delta`/`final`/`aborted`/`error`）テスト (Red)
- [ ] Test: POST /api/chat/abort（run 単位 / sessionKey 全件） + stop トリガー経路テスト (Red)
- [ ] Test: GET /api/chat/history?sessionKey=... / POST /api/heartbeat/run / GET /api/events/stream / GET /api/heartbeat/last（`event: heartbeat` push + snapshot 契約）テスト (Red)
- [ ] Impl: API Server 実装（CommandQueue main + session レーン経由、`127.0.0.1` バインド、冪等キー管理）(Green)
- [ ] Impl: POST /api/chat/abort / GET /api/chat/history?sessionKey=... / POST /api/heartbeat/run / GET /api/events/stream / GET /api/heartbeat/last 実装 (Green)
- [ ] Impl: SSE keepalive + reconnect ポリシー
- [ ] Integration: チャット → CommandQueue → AgentRunner → SSE の結合テスト

### Phase 7: Web UI

- [ ] assistant-ui の Thread + Composer 組み込み
- [ ] SSE ストリーミング接続（カスタム Runtime）
- [ ] ハートビートアラート表示コンポーネント
- [ ] [MVP+ 任意] セッション切り替え UI
- [ ] 開発サーバー設定（Vite proxy → API Server）

### Phase 8: 統合と検証

- [ ] 全テスト実行 (`pnpm run check`)
- [ ] JSONL 収集プロセスとの並行動作確認
- [ ] ハートビート E2E 動作確認（HEARTBEAT_OK 抑制、アラート表示）
- [ ] メモリ読み書きの E2E 確認
- [ ] セッション永続化と復元の E2E 確認
- [ ] ドキュメント更新（README, CLAUDE.md）

---

## 8. 完了の定義

### 8.1 機能 DoD

- [ ] AC-01: Slack イベントが JSONL 追記保存される
- [ ] AC-02: AI 応答に JSONL 由来コンテキストが取り込まれる
- [ ] AC-03: OpenClaw 準拠の SDK 実行手順を満たす
- [ ] AC-04: 同一 `sessionKey` で同時実行が発生しない
- [ ] AC-05: 異なる `sessionKey` 間でコンテキストが混線しない
- [ ] AC-06: 一時失敗時の再試行/切り詰め再試行が機能する
- [ ] AC-07: HEARTBEAT_OK 抑制時に `ran` 維持 + `ok-*` ログが残る
- [ ] AC-08: Heartbeat アラートが通知される
- [ ] AC-09: `HEARTBEAT.md` 実質空で `skipped` になる
- [ ] AC-10: `sessions.json` の Session Entry（`sessionKey -> sessionId/sessionFile`）と transcript JSONL が永続化される
- [ ] AC-11: 明示指示時のみメモリ書き込みされ、次回ターンで再利用される。Heartbeat 実行時は書き込まれない
- [ ] AC-12: `SOUL.md` が通常対話/Heartbeat の応答方針に反映される
- [ ] AC-13: SystemEventQueue が `sessionKey` ごとに注入・drain される
- [ ] AC-14: UI ストリーミング完了 + `GET /api/events/stream` の `event: heartbeat` push および `GET /api/heartbeat/last` スナップショット復元が機能する
- [ ] AC-15: 通常対話/Heartbeat の両方で `MEMORY.md` と当日・前日メモを参照する
- [ ] AC-16: 24h 同一 Heartbeat 本文が `duplicate` で抑制され `ran` を維持する
- [ ] AC-17: セッショントランスクリプト直近窓が入力へ取り込まれる
- [ ] AC-18: アラート配信前 readiness 失敗は `skipped` 記録、`ok-token`/`ok-empty` 側の可視化判定では `ran + ok-*` を維持する
- [ ] AC-19: 致命的エラー時に `state: "error"` で終端し、終端 state は 1 回のみ配信される
- [ ] AC-20: Heartbeat 送信 Body に Current time 行が重複なく注入される
- [ ] AC-21: 同一 `idempotencyKey` 再送が冪等処理される
- [ ] AC-22: `requests-in-flight` 時に `skipped` 記録 + 1 秒後再試行される
- [ ] P-01: `pnpm run assistant` で起動しチャット画面が表示される
- [ ] P-03: `heartbeat.session` の無効/他 agent 指定が main セッションへフォールバックされる

### 8.2 品質 DoD

- [ ] P-02: 全テストがパスし `pnpm run check` が成功する
- [ ] 既存の Slack 収集パイプラインに影響がない
- [ ] API サーバーが `127.0.0.1` にのみバインドされている

---

## 9. 懸念事項と未確定事項

### 方針確定

1. **pi-coding-agent SDK の利用範囲** — MVP ではフル統合（`createAgentSession` + `activeSession.prompt` + `SessionManager`）を採用し、セッション管理を自前実装しない

2. **assistant-ui の Runtime 接続方式** — MVP ではカスタム Runtime + SSE（POST で run 作成、GET SSE で購読）に固定する

3. **フロントエンドのビルド・配信方式** — Vite dev server + proxy で開発し、本番配信方式は次フェーズで確定する

4. **メモリファイルの管理ポリシー** — memory/YYYY-MM-DD.md はMVPでは手動管理とし、将来的に MEMORY.md への昇格・古いファイルの削除を検討する

### 技術的懸念

- JSONL が 1 日数千行を超える場合のコンテキストウィンドウ管理（切り詰めアルゴリズムの精度）
- ハートビートの AI 呼び出しコスト（30 分毎 × 1 日 = 最大 48 回/日）。モデルカスケードで安価なモデルを設定することで緩和可能
- pi-coding-agent SDK のライセンスと再配布可能性
- メモリファイルが大きくなった場合のプロンプト圧迫（ベクトル検索なしのため）

### プロトタイプとして許容するリスク

- ベクトル検索なし（全文読み込みのみ）
- セッションコンパクションなし（履歴が長くなると手動リセット）
- シングルユーザー前提
- JSONL の窓読み（sinceMinutes + limit）に依存。古い文脈が取りこぼされる可能性がある

---

## 10. 次フェーズ候補（MVP 後）

MVP 完了後に検討する機能拡張の候補。優先度・実施判断は MVP の運用結果を踏まえて行う。

1. **JSONL 索引化** — SQLite または軽量インデックスでコンテキスト抽出を高速化し、窓読みの取りこぼしを解消
2. **重要イベント分類器** — ルールベース + LLM によるイベント重要度判定で、Heartbeat 誤通知を削減
3. **マルチチャネル統合** — GitHub / git-local イベントの取り込みと横断要約
4. **通知ポリシー / 静穏時間の高度化** — ユーザーごとのカスタム通知ルール、曜日別 activeHours
5. **Cron / Webhook / PubSub 連携** — ハートビート以外のマルチトリガー起動（OpenClaw Cron パターン）
6. **モデルカスケードの本格実装** — 軽量モデル判定 + 上位モデル昇格の自動切り替え
7. **Hook 拡張点** — `before_agent_start` / `agent_end` フックの提供（プラグイン的な前後処理）
8. **実行中 run への steer** — 割り込み追加入力（中断せず文脈へ注入）の導入
9. **action 承認 API** — approve/reject による Human-in-the-Loop の外部副作用実行
10. **セマンティック検索** — sqlite-vec + FTS5 のハイブリッド検索（OpenClaw はベクトル 70% + BM25 30% の加重平均）

---

## Appendix: OpenClaw から取り込んだ設計パターン

| パターン                          | OpenClaw の実装                                                                                                                                                             | Adjutant MVP での実装                                                                                                                                                                              |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ハートビート**                  | `heartbeat-runner.ts`: 30分間隔タイマー、HEARTBEAT_OK 抑制、アクティブ時間帯制御                                                                                            | 同等。MVP でも `activeHours` を採用                                                                                                                                                                |
| **システムイベントキュー**        | `system-events.ts`: セッション単位の FIFO キュー（最大20件）、次のプロンプトに前置き注入。投入元は monitor/system/cron など                                                 | 同等（投入元は monitor/system/cron。HeartbeatRunner は enqueue せず drain 側で利用）                                                                                                               |
| **コマンドキュー（排他制御）**    | `command-queue.ts` + `CommandLane`: セッション/グローバルレーンで直列化                                                                                                     | 同等（`main` + `session:<sessionKey>` の二段レーンで直列化）                                                                                                                                       |
| **HEARTBEAT_OK トークン制御**     | `heartbeat.ts`: `stripHeartbeatToken()` でトークン除去、`ackMaxChars` で閾値判定、HTML タグ・Markdown 修飾除去後に判定                                                      | 同等（マークアップ正規化を含む）                                                                                                                                                                   |
| **メモリシステム**                | `MEMORY.md` + `memory/*.md` + SQLite ベクトル検索 + chokidar 監視                                                                                                           | 簡易版（ファイル全文読み込み、ベクトル検索なし）                                                                                                                                                   |
| **SOUL.md / AGENTS.md / USER.md** | システムプロンプトにペルソナ（SOUL.md）・ユーザー情報（USER.md）・ワークスペースルール（AGENTS.md）を注入                                                                   | 同等（SOUL.md / USER.md / AGENTS.md を注入）                                                                                                                                                       |
| **モデルカスケード**              | ハートビートに安価モデル、複雑な推論に上位モデルを使い分け。コスト最適化                                                                                                    | ハートビート用モデル設定（`heartbeat.model`）で同等。対話はデフォルトモデル                                                                                                                        |
| **セッション永続化**              | JSONL 形式でセッション履歴保存、セッションマネージャで管理                                                                                                                  | SDK が正（source of truth）。UI 履歴は TranscriptReader で SDK transcript + `sessions.json` から投影                                                                                               |
| **Human-in-the-Loop**             | アラートは提案形式、実行はユーザー承認後                                                                                                                                    | MVPでは提案と追質問の対話に限定。外部副作用は実行しない                                                                                                                                            |
| **重複排除**                      | 24時間内の同一アラート抑制。直前 1 件の完全テキストを Session Entry Store（`sessions.json`）に永続化（`lastHeartbeatText` + `lastHeartbeatSentAt`）。プロセス再起動後も有効 | 同等。Session Entry（例: `sessions.json`）に `lastHeartbeatText` + `lastHeartbeatSentAt` を保持し、24h ウィンドウで完全テキスト比較。`contentHash`（SHA-256 先頭 16 文字）はログ・可観測性用途のみ |
