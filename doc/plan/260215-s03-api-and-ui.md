# API サーバー + Web UI 層

> **マスタープラン**: `doc/plan/260214-s01-ai-assistant-mvp.md`
> **担当**: 担当 C（API + フロントエンド）
> **並行プラン**: s01（データ・キュー基盤層）、s02（AI 実行層）

---

## 1. 概要と目的 Overview and Purpose

### What

HTTP API サーバー（SSE ストリーミング含む）と assistant-ui ベースの Web UI を実装する。
ユーザーとシステムの接点となるインターフェース層全体を担う。

### Why

- API サーバーは全バックエンドモジュールのオーケストレーション層。ユーザーリクエストを受けて CommandQueue → AgentRunner の実行パイプラインを駆動する
- Web UI は唯一のユーザー接点。SSE ストリーミングによるリアルタイム表示とハートビート状態表示を提供する
- API サーバーと Web UI を同一担当にすることで、SSE 契約（サーバー側送信 + クライアント側受信）を一貫して管理できる

### How

- API サーバーは Node.js HTTP サーバー + SSE ストリーミングで構築する。メッセージ送信（POST）とストリーム取得（GET SSE）を分離する 2 段パターンを採用
- Web UI は `@assistant-ui/react` + Vite + React 19 で構築。カスタム Runtime で SSE ストリームに接続する
- 開発中は s01/s02 のモジュールをモックし、API 契約レベルでの単体テストを先行する

---

## 2. 担当スコープ

### 2.1 実装モジュール

| モジュール | ファイル | 責務 |
|-----------|---------|------|
| **API Server** | `src/assistant/api-server.ts` | HTTP エンドポイント、SSE ストリーミング、ChatHandler オーケストレーション、sessionKey 解決、冪等性 |
| **Web UI** | `src/ui/` | assistant-ui Thread + Composer、カスタム Runtime（SSE クライアント）、ハートビート表示 |

### 2.2 担当 AC

| AC | 概要 | 主担当 |
|----|------|--------|
| AC-14 | UI ストリーミング表示（text_delta=0 時は text_end.text で本文更新）+ Heartbeat ポーリング表示 | ◎ |
| AC-19 | 終端一意性（error → run_end(failed) で終端） | ◎ |
| AC-21 | clientMessageId 冪等再送 | ◎ |
| P-01 | `pnpm run assistant` で起動しチャット画面が表示される | ◎ |

### 2.3 基盤準備（Phase 0 で担当）

- `package.json` に `"assistant"` スクリプトを追加
- assistant-ui 基盤セットアップ（Vite + React）
- 開発サーバー設定（Vite proxy → API Server）

---

## 3. インターフェース契約

### API Server

```typescript
// src/assistant/api-server.ts

// --- チャット ---

// POST /api/chat/messages — ユーザーメッセージ送信、run を作成
// Request:  { text: string, sessionId?: string, sessionKey?: string, clientMessageId: string }
// Response: { runId: string, sessionId: string, sessionKey: string, accepted: true, deduplicated: boolean }
//   → コマンドキュー経由で直列化。run は非同期で実行開始される。
//   → clientMessageId は冪等キー。同一 (sessionKey, clientMessageId) の再送は
//     冪等 TTL（既定 300 秒）内であれば既存 runId を返し、新規キュー投入しない。
//     deduplicated: true の場合は既存 run への合流を示す。

// --- sessionKey 解決ルール ---
// 優先順:
//   1. sessionKey 指定時はそれを優先
//   2. sessionId のみ指定時は sessionId → sessionKey を引いて解決
//   3. 両方指定で不整合な場合は 400 Bad Request
//   4. どちらも未指定時は "main" 用の既定 sessionKey を採用し、
//      必要に応じて新規 sessionId を採番

// GET /api/chat/runs/:runId/stream — 指定 run の SSE ストリーム
// Response: SSE stream (text/event-stream)
//   event: run_started  data: { runId, sessionId, sessionKey, seq }
//   event: text_delta   data: { runId, delta, seq }
//   event: tool_call    data: { runId, toolCallId, name, params, seq }
//   event: tool_result  data: { runId, toolCallId, name, isError, result, seq }
//   event: text_end     data: { runId, text, seq }
//   event: run_end      data: { runId, status: "completed" | "failed", seq }
//   event: error        data: { runId, message, seq }
```

**SSE 仕様:**

- **内部→公開 SSE 変換**: pi-coding-agent SDK の内部イベントを公開 SSE へ変換する（マスタープラン §4.1 API Server 参照）
- **seq 連番**: runId ごとに 1..N で再採番。クライアントは欠落・逆転を検知可能
- **text_end**: 本文確定イベント。runId ごとに 1 回のみ送信する。非ストリーミングモデルでは text_delta が 0 件のまま text_end のみ到着しうるため、クライアントは text_end.text 単独で本文表示を更新できること
- **run_end**: run の唯一の終端イベント。runId ごとに 1 回のみ。重複終端を検出した場合、2 件目以降は公開 SSE へ送らず内部診断ログに記録する。致命的エラー時は error 送出後に必ず run_end(failed) で終端
- **keepalive**: 15 秒間隔で SSE コメント行（`: ping\n\n`）を送信
- **再接続ポリシー**: クライアント側で指数バックオフ（initial=2s, max=30s, factor=1.8, jitter=25%, maxAttempts=12）
- **stream 未接続時**: 接続時に完了済みの run_end を即送信して閉じる
- **順序保証**: HTTP/1.1 単一接続で送信順 = 受信順。seq で検証可能

```typescript
// --- ハートビート ---

// POST /api/heartbeat/run — Heartbeat 実行（手動/定期）
// Request:  { mode: "now" | "scheduled" }
// Response: HeartbeatRunResult

// GET /api/heartbeat/last — 最新ハートビート結果取得（ポーリング）
// Response: HeartbeatEventPayload | null
//   - MVP は "main" セッションの最新イベントを返す
//   - クライアントは 3 秒間隔でポーリング

// --- 履歴取得 ---

// GET /api/chat/sessions/:sessionId/messages — 表示用履歴取得
// Response: SessionMessage[]
```

### StreamEvent 型

```typescript
type StreamEvent =
  | { type: "run_started"; runId: string; sessionId: string; sessionKey: string; seq: number }
  | { type: "text_delta"; runId: string; delta: string; seq: number }
  | { type: "tool_call"; runId: string; toolCallId: string; name: string; params: unknown; seq: number }
  | { type: "tool_result"; runId: string; toolCallId: string; name: string; isError: boolean; result: unknown; seq: number }
  | { type: "text_end"; runId: string; text: string; seq: number }
  | { type: "run_end"; runId: string; status: "completed" | "failed"; seq: number }
  | { type: "error"; runId: string; message: string; seq: number };
```

### Web UI

- **ライブラリ**: `@assistant-ui/react` + React 19
- **バンドラ**: Vite（dev server + proxy → API Server :3100）
- **Runtime**: カスタム Runtime で SSE ストリームに接続。`useExternalStoreRuntime` または同等の API を使用
- **ハートビート表示**: `GET /api/heartbeat/last` を 3 秒間隔でポーリングし、indicatorType に応じた状態表示
- **コンポーネント構成**:
  - Thread — メッセージ一覧（ストリーミング表示）
  - Composer — メッセージ入力
  - HeartbeatIndicator — ハートビート状態バッジ / 最新アラートプレビュー

---

## 4. 依存モジュール契約（s01/s02 から消費）

| 消費モジュール | プラン | 使用箇所 | 用途 |
|-------------|------|---------|------|
| `CommandQueue.enqueueCommand()` | s01 | API Server | リクエストの排他制御投入 |
| `SystemEventQueue.enqueue/drain()` | s01 | ChatHandler | イベントの投入と drain |
| `EventReader.readEvents()` | s01 | ChatHandler | 新規イベント取得 |
| `MemoryReader.readMemoryFiles()` | s01 | ChatHandler | メモリ読み込み |
| `ContextBuilder.buildEventContext()` | s01 | ChatHandler | プロンプト組み立て |
| `SessionStore.appendEvent/loadMessages/loadRecentSessionEvents()` | s01 | API Server | イベントログ読み書き |
| `AgentRunner.runAgent()` | s02 | ChatHandler | LLM 実行 |
| `HeartbeatRunner.startHeartbeat()` | s02 | API Server 起動時 | ハートビート開始 |

開発中はこれらをモックして先行実装可能。特に API Server のテストは全依存をモックし、HTTP/SSE 契約レベルで検証する。

---

## 5. エラーと例外

| エラー | 対応 |
|--------|------|
| sessionKey + sessionId 不整合 | 400 Bad Request を返す |
| clientMessageId 冪等再送 | TTL 内: 既存 runId を返す（`deduplicated: true`）。TTL 外: 新規 run 作成 |
| run 完了後の SSE 接続 | 完了済み run_end を即送信して閉じる |
| SSE 接続断 | クライアント側で指数バックオフ再接続。サーバー側はリソース解放 |
| AgentRunner 失敗 | error イベント送出後、run_end(status: "failed") で終端 |

---

## 6. テスト戦略

### 6.1 テスト一覧

| 種類 | 対象 | 方針 |
|------|------|------|
| Unit | API Server — POST /api/chat/messages | sessionKey 解決ルール（4段階）、`accepted: true` 契約、clientMessageId 冪等性（TTL 内重複 + TTL 外新規） |
| Unit | API Server — GET /api/chat/runs/:runId/stream | SSE seq 連番、text_end 単発保証（text_delta 0 件ケース含む）、run_end 終端保証（重複 run_end は公開 SSE へ出さず内部診断ログへ記録）、error → run_end(failed) 順序、keepalive ping |
| Unit | API Server — SSE 変換 | pi-coding-agent 内部イベント → StreamEvent 変換、tool_call/tool_result 中継、compaction/thinking の除外 |
| Unit | API Server — ハートビート API | POST /api/heartbeat/run、GET /api/heartbeat/last（3s ポーリング契約） |
| Unit | API Server — 履歴 API | GET /api/chat/sessions/:id/messages |
| Unit | API Server — エッジケース | stream 未接続時の完了済み run_end 即送信、再接続時の振る舞い |
| Integration | API Server | POST → CommandQueue → AgentRunner → SSE の結合テスト（s01/s02 結合後） |
| Manual | Web UI | assistant-ui 表示、SSE ストリーミング接続、ハートビート表示、Vite dev server |

### 6.2 モック境界

- CommandQueue → モック（enqueueCommand は即座に task() を実行するスタブ）
- AgentRunner → モック（固定応答 or ストリーミング模擬）
- HeartbeatRunner → モック（固定 HeartbeatRunResult を返す）
- SessionStore → モック（インメモリ配列）
- EventReader / ContextBuilder / MemoryReader → モック
- SystemEventQueue → モック

---

## 7. 実装タスクリスト

### Phase 0: 基盤準備

- [ ] `package.json` に `"assistant"` スクリプトを追加（`tsx src/assistant/index.ts` 等）
- [ ] assistant-ui の依存追加（`@assistant-ui/react`, `react`, `react-dom`）
- [ ] Vite 基盤セットアップ（`vite.config.ts`、React プラグイン、proxy 設定 → localhost:3100）
- [ ] `src/ui/` ディレクトリ構成作成（App.tsx, main.tsx, index.html）

### Phase 1: API Server — チャット基本フロー

- [ ] Test: POST /api/chat/messages が `{ accepted: true, runId, sessionId, sessionKey, deduplicated: false }` を返す (Red)
- [ ] Test: sessionKey 解決 — sessionKey 指定時はそれを優先 (Red)
- [ ] Test: sessionKey 解決 — sessionId のみ指定時は逆引き (Red)
- [ ] Test: sessionKey 解決 — 両方指定で不整合時に 400 (Red)
- [ ] Test: sessionKey 解決 — どちらも未指定時は "main" + 新規 sessionId (Red)
- [ ] Impl: POST /api/chat/messages ハンドラ + sessionKey 解決ロジック (Green)
- [ ] Test: GET /api/chat/runs/:runId/stream — run_started + text_delta + text_end + run_end の基本 SSE フロー (Red)
- [ ] Test: SSE seq 連番 — runId ごとに 1..N で再採番される (Red)
- [ ] Impl: SSE ストリーミング基本実装 (Green)

### Phase 2: API Server — SSE 詳細

- [ ] Test: text_end 単発保証 — runId ごとに 1 回のみ送信、text_delta 0 件でも text_end.text で本文表示を更新できる (Red)
- [ ] Test: run_end 終端保証 — runId ごとに 1 回のみ送信、重複 run_end は公開 SSE へ出さず内部診断ログへ記録 (Red)
- [ ] Test: error → run_end(failed) — 致命的エラー時の順序保証 (Red)
- [ ] Test: tool_call / tool_result SSE 中継 — toolCallId で相関 (Red)
- [ ] Impl: SSE 変換層（pi-coding-agent 内部イベント → StreamEvent） (Green)
- [ ] Test: SSE keepalive — 15 秒間隔で `: ping\n\n` 送信 (Red)
- [ ] Test: stream 未接続時 — 接続時に完了済み run_end を即送信 (Red)
- [ ] Impl: keepalive + 未接続時処理 (Green)

### Phase 3: API Server — 冪等性 + 追加 API

- [ ] Test: clientMessageId 冪等性 — TTL 内再送で既存 runId 返却 + `deduplicated: true` (Red)
- [ ] Test: clientMessageId — TTL 外再送で新規 run 作成 (Red)
- [ ] Impl: 冪等キー管理（Map + TTL 期限切れクリーンアップ） (Green)
- [ ] Test: GET /api/chat/sessions/:id/messages — SessionMessage[] を返す (Red)
- [ ] Impl: 履歴取得エンドポイント (Green)
- [ ] Test: POST /api/heartbeat/run — HeartbeatRunResult を返す (Red)
- [ ] Test: GET /api/heartbeat/last — HeartbeatEventPayload | null を返す (Red)
- [ ] Impl: ハートビート API エンドポイント (Green)

### Phase 4: API Server — ChatHandler オーケストレーション

- [ ] Impl: ChatHandler — EventReader → テンプレート整形 → SEQ 投入 → CQ enqueue → AgentRunner → SessionStore 保存 のフルフロー (Green)
- [ ] Impl: API Server `127.0.0.1` バインド（セキュリティ） (Green)
- [ ] Impl: SSE 再接続ポリシー（サーバー側：再接続時に run 状態返却） (Green)
- [ ] Integration: チャット → CommandQueue → AgentRunner → SSE の結合テスト

### Phase 5: Web UI

- [ ] Impl: `src/ui/App.tsx` — assistant-ui の Thread + Composer 組み込み
- [ ] Impl: カスタム Runtime — POST /api/chat/messages で run 作成 → GET SSE で購読
- [ ] Impl: SSE クライアント — StreamEvent パース、seq 検証、指数バックオフ再接続
- [ ] Impl: HeartbeatIndicator コンポーネント — GET /api/heartbeat/last を 3 秒ポーリング、indicatorType に応じた表示
- [ ] Impl: 起動時の履歴読み込み — GET /api/chat/sessions/:id/messages
- [ ] Impl: Vite proxy 設定確認 + 開発サーバー動作確認
- [ ] [MVP+ 任意] セッション切り替え UI

### Phase 6: 統合と検証

- [ ] 全テスト実行 (`pnpm run check`)
- [ ] JSONL 収集プロセスとの並行動作確認
- [ ] ハートビート E2E 動作確認（HEARTBEAT_OK 抑制、アラート表示）
- [ ] メモリ読み書きの E2E 確認
- [ ] セッション永続化と復元の E2E 確認
- [ ] ドキュメント更新（README, CLAUDE.md）
- [ ] P-01 検証: `pnpm run assistant` で API サーバーと Web UI が起動しチャット画面が表示される

---

## 8. 完了の定義

### 8.1 機能 DoD

- [ ] AC-14: assistant-ui でストリーミング表示（text_delta=0 時は text_end.text で本文更新）+ GET /api/heartbeat/last ポーリング表示が機能する
- [ ] AC-19: 致命的エラー時に error 後 run_end(status: "failed") で終端する
- [ ] AC-21: 同一 sessionKey + clientMessageId 再送が冪等処理される
- [ ] P-01: `pnpm run assistant` で起動しチャット画面が表示される
- [ ] P-02: 全テストがパスし `pnpm run check` が成功する

### 8.2 品質 DoD

- [ ] 全ユニットテスト・統合テストがパスする
- [ ] `pnpm run typecheck` がエラーなし
- [ ] `pnpm run lint` がエラーなし
- [ ] API サーバーが `127.0.0.1` にのみバインドされている
- [ ] 既存の Slack 収集パイプラインに影響がない

---

## 9. 懸念事項

- assistant-ui の Runtime API（`useExternalStoreRuntime` 等）のドキュメントが限定的。SSE カスタム接続の実装パターンは assistant-ui のソースコードやサンプルを参照する必要がある
- SSE 再接続ポリシーのサーバー側実装は、run 状態のインメモリ管理が必要。プロセス再起動時に進行中 run が消失するリスクがある（MVP では許容）
- Web UI のテストは手動確認が中心。E2E テスト自動化は MVP 範囲外
- Vite dev server と API Server のポート分離（Vite: 5173, API: 3100）は proxy 設定で解決するが、本番配信方式は次フェーズで確定する
