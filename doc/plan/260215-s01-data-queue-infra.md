# データ・キュー基盤層

> **マスタープラン**: `doc/plan/260214-s01-ai-assistant-mvp.md`
> **担当**: 担当 A（バックエンド基盤）
> **並行プラン**: s02（AI 実行層）、s03（API + Web UI 層）

---

## 1. 概要と目的 Overview and Purpose

### What

AI Assistant MVP のデータ I/O・キュー・コンテキスト組み立てを担う基盤モジュール群を実装する。
他の 2 プラン（AI 実行層・API+UI 層）が依存するインターフェースを提供する最下層レイヤー。

### Why

- すべての上位モジュール（AgentRunner, HeartbeatRunner, API Server）がこの層のインターフェースに依存する
- 先行して型定義とモジュールを確定させることで、並行開発のブロッカーを解消する

### How

以下の 7 モジュールを TDD で実装し、上位レイヤーが mock 可能なインターフェースを提供する。

```
JSONL ファイル → EventReader → ContextBuilder → (上位: AgentRunner)
                                    ↑
メモリファイル → MemoryReader ──────┘
                                    ↑
                 SystemEventQueue ──┘
                                    ↑
                 SessionStore ──────┘ (recentTranscript)

CommandQueue → (上位: API Server / HeartbeatRunner)
MemoryWriter → (上位: AgentRunner ツール登録)
```

---

## 2. 担当スコープ

### 2.1 実装モジュール

| モジュール | ファイル | 責務 |
|-----------|---------|------|
| **EventReader** | `src/assistant/event-reader.ts` | JSONL からイベント窓を読み込み `NormalizedEvent[]` を返す |
| **SystemEventQueue** | `src/assistant/system-event-queue.ts` | sessionKey 単位の FIFO キュー。前置き注入パターン |
| **CommandQueue** | `src/assistant/command-queue.ts` | sessionKey 単位レーンでの排他制御 |
| **ContextBuilder** | `src/assistant/context-builder.ts` | イベント + メモリ + SystemEvent + transcript → プロンプトテキスト |
| **MemoryReader** | `src/assistant/memory-reader.ts` | MEMORY.md / memory/YYYY-MM-DD.md の読み込み |
| **MemoryWriter** | `src/assistant/memory-writer.ts` | memory/YYYY-MM-DD.md 追記、MEMORY.md 更新 |
| **SessionStore** | `src/assistant/session-store.ts` | UI 表示用イベントログの JSONL 永続化 |

### 2.2 共有型定義

本プランの Phase 0 で `src/assistant/types.ts` を作成し、全プランで共有する型を定義する。

### 2.3 担当 AC

| AC | 概要 | 主担当 |
|----|------|--------|
| AC-01 | Slack イベント JSONL 保存（既存。EventReader の入力源確認） | ◎ |
| AC-02 | JSONL 文脈注入 | ◎ |
| AC-04 | 同一 sessionKey 排他 | ◎ |
| AC-05 | sessionKey 分離 | ◎ |
| AC-10 | トランスクリプト永続化 | ◎ |
| AC-13 | SystemEventQueue 注入/排出 | ◎ |
| AC-15 | メモリ参照（通常/Heartbeat） | ◎ |
| AC-17 | トランスクリプト直近窓注入 | ◎ |

---

## 3. インターフェース契約

マスタープラン §4.1 の該当モジュールをそのまま準拠する。以下に要点を再掲する。

### EventReader

```typescript
// src/assistant/event-reader.ts
export type ReadEventsOptions = {
  dataDir: string;
  date?: string;        // "YYYY-MM-DD" (default: today)
  kinds?: string[];     // filter by event kind
  channels?: string[];  // filter by channel_id
  sinceMinutes?: number; // 直近 N 分以内のイベントのみ (default: 60)
  limit?: number;        // 最大取得件数、新しい順に切り詰め (default: 200)
};

export function readEvents(opts: ReadEventsOptions): Promise<NormalizedEvent[]>;
```

### SystemEventQueue

```typescript
// src/assistant/system-event-queue.ts
export type SystemEvent = {
  text: string;
  ts: number;  // epoch ms
};

export type SystemEventEnqueueOptions = {
  sessionKey: string;
  contextKey?: string;
};

// キュー制約:
// - sessionKey 単位 FIFO、MAX_EVENTS = 20、超過時は古い方を破棄
// - 連続する同一テキストはドロップ（連続重複排除）
// - drain 後はキューを空にし lastText をリセット

export function enqueueSystemEvent(event: SystemEvent, opts: SystemEventEnqueueOptions): void;
export function drainSystemEvents(sessionKey: string): SystemEvent[];
export function peekSystemEvents(sessionKey: string): SystemEvent[];
export function hasSystemEvents(sessionKey: string): boolean;
export function isSystemEventContextChanged(sessionKey: string, contextKey?: string): boolean;
```

### CommandQueue

```typescript
// src/assistant/command-queue.ts
export type CommandFn<T> = () => Promise<T>;

export type CommandQueueOptions = {
  sessionKey: string;
};

export function enqueueCommand<T>(fn: CommandFn<T>, opts: CommandQueueOptions): Promise<T>;
export function getQueueSize(sessionKey: string): number;
export function isIdle(sessionKey: string): boolean;
export function isGlobalIdle(): boolean;
```

### ContextBuilder

```typescript
// src/assistant/context-builder.ts
export type ContextBuildOptions = {
  events: NormalizedEvent[];
  systemEvents?: SystemEvent[];
  recentTranscript?: SessionTranscriptEvent[];
  memoryContent?: string;
  dailyMemoryContent?: string;
  yesterdayMemoryContent?: string;
  maxTokenEstimate?: number; // default: 8000
};

export type ContextBuildResult = {
  text: string;
  truncated: boolean;
  eventCount: number;
};

export function buildEventContext(opts: ContextBuildOptions): ContextBuildResult;
```

### MemoryReader

```typescript
// src/assistant/memory-reader.ts
export type MemoryReadOptions = {
  workspaceDir: string;
  timezone: string;
};

export function readMemoryFiles(opts: MemoryReadOptions): Promise<{
  longTerm: string | null;
  daily: string | null;
  yesterday: string | null;
}>;
```

### MemoryWriter

```typescript
// src/assistant/memory-writer.ts
export type MemoryWriteOptions = {
  workspaceDir: string;
  timezone: string;
};

export function appendDailyMemory(content: string, opts: MemoryWriteOptions): Promise<void>;
export function updateLongTermMemory(content: string, opts: MemoryWriteOptions): Promise<void>;
```

### SessionStore

```typescript
// src/assistant/session-store.ts
export type SessionEventType =
  | "user_message"
  | "assistant_message"
  | "tool_call"
  | "tool_result"
  | "system_event";

export type SessionTranscriptEvent = {
  schema: "adjutant.session.event.v1";
  sessionId: string;
  sessionKey: string;
  runId: string;
  ts: string; // ISO8601
  type: SessionEventType;
  payload: Record<string, unknown>;
};

export type SessionMessage = {
  type: SessionEventType;
  role: "user" | "assistant" | "system";
  content: string;
  ts: string;
  sessionId: string;
  sessionKey: string;
  runId: string;
  isHeartbeat?: boolean;
  payload?: Record<string, unknown>;
};

export type SessionStoreOptions = {
  sessionDir: string;
  sessionId: string;
};

export function appendEvent(evt: SessionTranscriptEvent, opts: SessionStoreOptions): Promise<void>;
export function loadSessionEvents(opts: SessionStoreOptions): Promise<SessionTranscriptEvent[]>;
export function loadMessages(opts: SessionStoreOptions): Promise<SessionMessage[]>;
export function loadRecentSessionEvents(
  opts: SessionStoreOptions & { limit: number },
): Promise<SessionTranscriptEvent[]>;
export function listSessions(sessionDir: string): Promise<string[]>;
```

---

## 4. エラーと例外

| エラー | 対応 |
|--------|------|
| JSONL ファイル不在 | 空配列を返す（エラーにしない） |
| MEMORY.md 不在 | `null` を返す（初回起動時） |
| memory/YYYY-MM-DD.md 不在 | `null` を返す |
| セッション JSONL 破損 | 読める行だけ読み込み、破損行はスキップ。破損検知をログに記録 |

---

## 5. テスト戦略

### 5.1 テスト一覧

| 種類 | 対象 | 方針 |
|------|------|------|
| Unit | EventReader | JSONL パース、日付フィルタ、sinceMinutes/limit 切り詰め、空ファイル処理 |
| Unit | SystemEventQueue | enqueue/drain/peek、MAX_EVENTS=20 上限、sessionKey 分離、連続重複排除、contextKey 変化検知、drain 後の cleanup |
| Unit | ContextBuilder | トークン切り詰め、truncated フラグ、メモリ注入、SystemEvent 注入、recentTranscript 注入、フォーマット出力 |
| Unit | CommandQueue | sessionKey レーン分離、直列実行、isIdle 判定、isGlobalIdle |
| Unit | MemoryReader | timezone に基づく today/yesterday 日付計算、ファイル不在時の null 返却、正常読み込み |
| Unit | MemoryWriter | ファイル追記・更新、日付パーティション |
| Unit | SessionStore | SessionTranscriptEvent JSONL 読み書き、必須項目（schema/sessionId/sessionKey/runId/type/ts/payload）検証、破損行スキップ、loadMessages 投影、loadRecentSessionEvents |
| Contract | NormalizedEvent | 既存スキーマとの整合性 |

### 5.2 モック境界

- JSONL ファイル読み込み → テスト用フィクスチャファイル
- ファイルシステム（メモリ書き出し） → テスト用 tmpdir
- タイマー → 不使用（本プランのモジュールにタイマー依存なし）

---

## 6. 実装タスクリスト

### Phase 0: 共有型定義と基盤準備

- [ ] `src/assistant/types.ts` に全プラン共有の型定義を作成（NormalizedEvent re-export、SystemEvent、SessionTranscriptEvent、SessionMessage、StreamEvent、HeartbeatRunResult、HeartbeatEventPayload 等）
- [ ] HEARTBEAT.md テンプレート作成
- [ ] SOUL.md テンプレート作成
- [ ] USER.md / AGENTS.md テンプレート作成

### Phase 1: EventReader

- [ ] Test: JSONL 読み込み — ファイル不在時に空配列、正常パース、日付フィルタ (Red)
- [ ] Impl: `readEvents()` 実装 (Green)
- [ ] Test: sinceMinutes/limit 切り詰め — 新しい順に切り詰め (Red)
- [ ] Impl: フィルタ・切り詰めロジック (Green)
- [ ] Test: kinds/channels フィルタ (Red)
- [ ] Impl: フィルタオプション (Green)

### Phase 2: SystemEventQueue

- [ ] Test: enqueue/drain 基本動作 — enqueue した順に drain される (Red)
- [ ] Impl: 基本 FIFO キュー (Green)
- [ ] Test: sessionKey 分離 — 異なる sessionKey 間でイベントが混線しない (Red)
- [ ] Impl: sessionKey ルーティング (Green)
- [ ] Test: MAX_EVENTS=20 上限 — 超過時は古い方から破棄 (Red)
- [ ] Test: 連続重複排除 — 同一テキスト連続投入でドロップ (Red)
- [ ] Test: contextKey 変化検知 — isSystemEventContextChanged (Red)
- [ ] Test: drain 後の cleanup — キュー空 + lastText リセット (Red)
- [ ] Impl: 上限・重複排除・contextKey ロジック (Green)

### Phase 3: CommandQueue

- [ ] Test: sessionKey 単位のレーン分離 — 異なる sessionKey は並行実行可能 (Red)
- [ ] Test: 同一 sessionKey の直列実行 — 同時実行が発生しない (Red)
- [ ] Test: isIdle / isGlobalIdle 判定 (Red)
- [ ] Test: getQueueSize (Red)
- [ ] Impl: CommandQueue 実装 (Green)

### Phase 4: ContextBuilder + MemoryReader + MemoryWriter

- [ ] Test: MemoryReader timezone 日付計算 — today/yesterday の正確な算出 (Red)
- [ ] Test: MemoryReader ファイル不在時の null 返却 (Red)
- [ ] Test: MemoryReader 正常読み込み (Red)
- [ ] Impl: `readMemoryFiles()` 実装 (Green)
- [ ] Test: MemoryWriter ファイル追記 — memory/YYYY-MM-DD.md に追記 (Red)
- [ ] Test: MemoryWriter 長期メモリ更新 — MEMORY.md 上書き (Red)
- [ ] Impl: `appendDailyMemory()` / `updateLongTermMemory()` 実装 (Green)
- [ ] Test: ContextBuilder — イベント配列 → プロンプトテキスト変換 (Red)
- [ ] Test: ContextBuilder — メモリ注入（longTerm + daily + yesterday） (Red)
- [ ] Test: ContextBuilder — SystemEvent 注入 (Red)
- [ ] Test: ContextBuilder — recentTranscript 注入（SessionTranscriptEvent[] からの投影） (Red)
- [ ] Test: ContextBuilder — maxTokenEstimate 超過時の切り詰め + truncated フラグ (Red)
- [ ] Test: ContextBuilder — ハートビートフロー（events あり, systemEvents 空）とチャットフロー（events 空, systemEvents あり）の排他パターン (Red)
- [ ] Impl: `buildEventContext()` 実装 (Green)
- [ ] Refactor: トークン概算と切り詰めロジック整理

### Phase 5: SessionStore

- [ ] Test: appendEvent + loadSessionEvents — 基本 JSONL 読み書き (Red)
- [ ] Test: 必須項目（schema/sessionId/sessionKey/runId/type/ts/payload）検証 (Red)
- [ ] Test: loadMessages — SessionTranscriptEvent → SessionMessage 投影 (Red)
- [ ] Test: loadRecentSessionEvents — limit 指定での直近 N 件取得 (Red)
- [ ] Test: 破損行スキップ — 壊れた行を含む JSONL でも読める行だけ返す (Red)
- [ ] Test: listSessions — セッション一覧取得 (Red)
- [ ] Impl: SessionStore 実装 (Green)

---

## 7. 完了の定義

### 7.1 機能 DoD

- [ ] AC-01: 既存 JSONL が EventReader で正しく読み込まれる
- [ ] AC-02: ContextBuilder が JSONL 由来イベントをプロンプトテキストに変換できる
- [ ] AC-04: CommandQueue が同一 sessionKey の同時実行を防止する
- [ ] AC-05: CommandQueue / SystemEventQueue が異なる sessionKey 間で分離される
- [ ] AC-10: SessionStore が sessionId/sessionKey/runId 付きで JSONL 永続化する
- [ ] AC-13: SystemEventQueue の enqueue/drain が sessionKey 単位で正しく動作する
- [ ] AC-15: MemoryReader が MEMORY.md + 当日・前日メモを正しく読み込む
- [ ] AC-17: ContextBuilder が recentTranscript を入力コンテキストに注入する

### 7.2 品質 DoD

- [ ] 全ユニットテストがパスする
- [ ] `pnpm run typecheck` がエラーなし
- [ ] `pnpm run lint` がエラーなし

---

## 8. 他プランへの提供インターフェース

本プランのモジュールは以下の上位プランから利用される。
上位プランは開発中にこれらのインターフェースをモックして先行開発可能。

| 消費プラン | 使用モジュール | 用途 |
|-----------|-------------|------|
| s02 (AI 実行層) | EventReader | HeartbeatRunner がイベント窓を読み込む |
| s02 (AI 実行層) | ContextBuilder | HeartbeatRunner / AgentRunner がプロンプトを組み立てる |
| s02 (AI 実行層) | MemoryReader | HeartbeatRunner がメモリを読み込む |
| s02 (AI 実行層) | MemoryWriter | AgentRunner が memory_write ツールとして登録する |
| s02 (AI 実行層) | CommandQueue | HeartbeatRunner が isIdle / enqueueCommand を使用する |
| s02 (AI 実行層) | SystemEventQueue | HeartbeatRunner がアラート要約を投入する |
| s03 (API+UI 層) | CommandQueue | API Server が enqueueCommand でリクエストを投入する |
| s03 (API+UI 層) | SystemEventQueue | ChatHandler がイベントを投入し drain する |
| s03 (API+UI 層) | EventReader | ChatHandler が新規イベントを取得する |
| s03 (API+UI 層) | MemoryReader | ChatHandler がメモリを読み込む |
| s03 (API+UI 層) | ContextBuilder | ChatHandler がプロンプトを組み立てる |
| s03 (API+UI 層) | SessionStore | API Server がイベントログを読み書きする |

---

## 9. 懸念事項

- JSONL が 1 日数千行を超える場合の EventReader の I/O 性能とメモリ使用量
- ContextBuilder のトークン概算精度（文字数ベースの概算 vs tiktoken 等）。MVP では文字数ベースで割り切る
- SessionStore の JSONL が肥大化した場合の loadMessages 性能。MVP ではファイル全読み込みで割り切る
