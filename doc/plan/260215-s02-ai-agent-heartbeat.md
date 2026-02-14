# AI 実行層（AgentRunner + HeartbeatRunner）

> **マスタープラン**: `doc/plan/260214-s01-ai-assistant-mvp.md`
> **担当**: 担当 B（AI 実行）
> **並行プラン**: s01（データ・キュー基盤層）、s03（API + Web UI 層）

---

## 1. 概要と目的 Overview and Purpose

### What

pi-coding-agent SDK を使った LLM 実行基盤（AgentRunner）と、定期ポーリングでプロアクティブ通知を行うハートビート機構（HeartbeatRunner）を実装する。
AI Assistant MVP の「頭脳」に相当するレイヤー。

### Why

- AgentRunner は全てのLLM呼び出しの唯一の実行経路。チャットもハートビートもこれを通る
- HeartbeatRunner はMVPの差別化機能。「指示を待たず自ら気づいて動く」エージェントの核心

### How

- AgentRunner は pi-coding-agent SDK の `createAgentSession` / `SessionManager` を利用し、OpenClaw 準拠の 6 ステップ実行手順を遵守する
- HeartbeatRunner は設定間隔（デフォルト30分）で EventReader → ContextBuilder → AgentRunner のパイプラインを起動し、HEARTBEAT_OK 判定・重複排除・各種スキップ条件を制御する

---

## 2. 担当スコープ

### 2.1 実装モジュール

| モジュール | ファイル | 責務 |
|-----------|---------|------|
| **AgentRunner** | `src/assistant/agent-runner.ts` | pi-coding-agent SDK を使った LLM 実行。セッション管理、ストリーミング、ツール登録、失敗回復 |
| **HeartbeatRunner** | `src/assistant/heartbeat-runner.ts` | 定期ポーリング、HEARTBEAT_OK 判定、重複排除、スキップ制御、Current time 注入 |

### 2.2 担当 AC

| AC | 概要 | 主担当 |
|----|------|--------|
| AC-03 | SDK 実行手順準拠（lock→open→create→subscribe→dispose） | ◎ |
| AC-06 | 失敗時再試行 / 切り詰め再試行 | ◎ |
| AC-07 | HEARTBEAT_OK 抑制時に `ran` 維持 + `ok-*` ログ | ◎ |
| AC-08 | Heartbeat アラート通知 | ◎ |
| AC-09 | 空 HEARTBEAT.md スキップ | ◎ |
| AC-11 | メモリ書き込みガード（Heartbeat 時は memory_write 無効化） | ◎ |
| AC-12 | SOUL.md 反映 | ◎ |
| AC-16 | 重複通知抑制（24h ウィンドウ） | ◎ |
| AC-18 | readiness 失敗の記録（アラート側 skipped / ok-* 側 ran 維持） | ◎ |
| AC-20 | Current time 注入 | ◎ |
| AC-22 | requests-in-flight 再試行 | ◎ |
| P-03 | グループセッション指定時の Heartbeat 無効化 | ◎ |

---

## 3. インターフェース契約

### AgentRunner

```typescript
// src/assistant/agent-runner.ts
// pi-coding-agent の createAgentSession / activeSession.prompt を使用。
//
// --- FR-AG-1: SDK 利用手順（OpenClaw 規範実装に準拠）---
//   1. セッションファイルの排他ロックを取得
//   2. セッションファイルの修復/事前準備、SessionManager を開く
//   3. SettingsManager を生成（モデル・ツール等の実行設定を反映）
//   4. createAgentSession で実行セッションを構築
//   5. 購読層でストリーミングイベントを受け取り、UI 向けに整形
//   6. 実行終了時にセッションを確定・解放
// 例外発生時も finally で flush/dispose + ロック解放を必須とする。

export type AgentRunOptions = {
  runId: string;
  prompt: string;
  systemPrompt?: string;       // SOUL.md + USER.md + AGENTS.md 結合テキスト
  sessionKey: string;
  sessionId?: string;
  isHeartbeat?: boolean;       // true → updatedAt 復元 + memory_write 無効化
  model?: string;              // モデルカスケード用
  onTextDelta?: (delta: string) => void;
  onToolCall?: (name: string, params: unknown) => void;
};

export type AgentRunResult = {
  runId: string;
  text: string;
  toolCalls?: Array<{ name: string; result: unknown }>;
};

export function runAgent(opts: AgentRunOptions): Promise<AgentRunResult>;
```

**サブ要件:**

| サブ要件 | 内容 | 対応 AC |
|----------|------|---------|
| FR-AG-1 | OpenClaw 準拠の SDK 利用手順 | AC-03 |
| FR-AG-2 | 最終回答と途中イベントの分離、部分応答の順序保証 | AC-14 / AC-19 |
| FR-AG-3 | 一時失敗は 2.5 秒待機後に 1 回再試行。コンテキスト超過時は切り詰め再試行 | AC-06 |
| FR-AG-4 | セッションファイル破損の検知・修復/退避 | AC-03 |

### HeartbeatRunner

```typescript
// src/assistant/heartbeat-runner.ts
export type HeartbeatConfig = {
  intervalMs: number;         // default: 1800000 (30m)
  timeoutMs?: number;         // default: 30000
  sessionKey?: string;        // default: "main"
  chatSessionKey?: string;    // default: "main"
  heartbeatFilePath: string;  // default: "HEARTBEAT.md"
  soulFilePath: string;       // default: "SOUL.md"
  userFilePath: string;       // default: "USER.md"
  agentsFilePath: string;     // default: "AGENTS.md"
  dataDir: string;
  timezone: string;
  retryDelayMs?: number;      // default: 1000
  maxRetries?: number;        // default: 10
  ackMaxChars: number;        // default: 300
  showOk?: boolean;           // default: false
  showAlerts?: boolean;       // default: true
  useIndicator?: boolean;     // default: true
  model?: string;
  activeHours?: {
    start: string;            // "HH:MM"
    end: string;              // "HH:MM"（"24:00" 可、start > end で深夜跨ぎ）
    timezone?: string;        // "user" | "local" | IANA タイムゾーン名
  };
};

export type HeartbeatRunResult =
  | {
      status: "ran";
      durationMs: number;
      alert?: string;
      contentHash?: string;
      modelId?: string;
    }
  | {
      status: "skipped";
      reason: string;        // OpenClaw 準拠: alerts-disabled / readiness の詳細理由を含む
    }
  | {
      status: "failed";
      reason: string;
    };

export type HeartbeatEventPayload = {
  ts: number;
  status: "sent" | "ok-empty" | "ok-token" | "skipped" | "failed";
  reason?: string;
  to?: string;               // OpenClaw互換, MVP省略可
  channel?: string;           // OpenClaw互換, MVP省略可
  accountId?: string;         // OpenClaw互換, MVP省略可
  preview?: string;
  durationMs?: number;
  hasMedia?: boolean;         // OpenClaw互換, MVP省略可
  silent?: boolean;           // OpenClaw互換, MVP省略可
  indicatorType?: "ok" | "alert" | "error";
};

export type HeartbeatRunRecord = {
  schema: "adjutant.heartbeat.result.v1";
  runAt: string;    // ISO8601
  sessionId?: string;
  sessionKey?: string;
  result: HeartbeatRunResult;
  modelId?: string;
  preview?: string;
};

export function startHeartbeat(
  config: HeartbeatConfig,
  onAlert: (result: HeartbeatRunResult) => void,
): { stop: () => void };
```

**HeartbeatRunner 内部仕様（マスタープラン §4.1 より）:**

- **stripHeartbeatToken**: HTML タグ除去 → `&nbsp;` 空白変換 → Markdown 修飾除去 → HEARTBEAT_OK 除去 → 残テキスト ≤ ackMaxChars なら `shouldSkip=true`
- **重複排除**: 直前送達テキスト（`lastHeartbeatText`）と 24h ウィンドウ（`lastHeartbeatSentAt`）で判定。重複時は `HeartbeatRunResult.status: "ran"` を維持し、`HeartbeatEventPayload.status: "skipped", reason: "duplicate"` を記録
- **Current time 注入**: Body 末尾に `Current time: <formattedTime> (<userTimezone>)` を注入。既存時は重複挿入しない
- **requests-in-flight 再試行**: `retryDelayMs` 間隔で最大 `maxRetries` 回再試行。超過時は次周期待ち
- **可視性設定（alerts-disabled）**: showOk / showAlerts / useIndicator が全 false の場合は `reason: "alerts-disabled"` でスキップ（モデル呼び出しなし）
- **グループセッション**: sessionKey がグループセッションの場合は `reason: "group-session-disabled"` でスキップ

---

## 4. 依存モジュール契約（s01 から消費）

本プランのモジュールは s01（データ・キュー基盤層）のインターフェースに依存する。
開発中はこれらをモックして先行実装可能。

| 消費モジュール | 使用箇所 | 用途 |
|-------------|---------|------|
| `EventReader.readEvents()` | HeartbeatRunner | イベント窓の読み込み |
| `ContextBuilder.buildEventContext()` | HeartbeatRunner | プロンプト組み立て |
| `MemoryReader.readMemoryFiles()` | HeartbeatRunner | メモリ読み込み |
| `MemoryWriter.appendDailyMemory()` / `updateLongTermMemory()` | AgentRunner | memory_write ツール |
| `CommandQueue.enqueueCommand()` / `isIdle()` | HeartbeatRunner | 排他制御 + アイドル判定 |
| `SystemEventQueue.enqueueSystemEvent()` | HeartbeatRunner | アラート要約をチャットセッションに投入 |

---

## 5. エラーと例外

| エラー | 対応 |
|--------|------|
| LLM API 一時エラー（通信/HTTP 系） | 2.5 秒待機後にリトライ 1 回。失敗時はエラーイベントを返す |
| LLM コンテキスト超過エラー | イベント/履歴入力を新しい順に切り詰めて再試行（1 回） |
| LLM モデル利用不可 | 即座に失敗を返す |
| HEARTBEAT.md 不在 | デフォルトプロンプトで実行 |
| SOUL.md / USER.md / AGENTS.md 不在 | デフォルト設定で動作 |
| SDK セッションファイル破損 | 修復試行 → 修復不能時はファイル退避 + 新規作成 |
| SDK セッション解放失敗 | finally で flush/dispose + ロック解放。失敗をログに記録 |

---

## 6. テスト戦略

### 6.1 テスト一覧

| 種類 | 対象 | 方針 |
|------|------|------|
| Unit | AgentRunner | SDK 利用手順（6 ステップ）、メモリ書き込みガード（明示トリガーありで memory_write 実行 / 明示トリガーなしで不実行 / ハートビート時は常に除外）、メモリ保存内容の次回ターン再利用、updatedAt 復元、SDK セッション後処理（例外時 flush/dispose）、コンテキスト超過時の切り詰め再試行、一時失敗リトライ |
| Unit | HeartbeatRunner | タイマー制御、HEARTBEAT_OK 判定（stripHeartbeatToken + マークアップ正規化）、空ファイルスキップ（実質空判定）、requests-in-flight/quiet-hours/alerts-disabled/readiness-failed/group-session-disabled スキップ、requests-in-flight 短周期再試行、重複排除（24h + lastHeartbeatText/lastHeartbeatSentAt）、modelId 記録、Current time 注入（重複防止含む）、可視性設定（showOk/showAlerts/useIndicator）、ok-token/ok-empty 側 readiness 判定 |
| Integration | AgentRunner + MemoryWriter | memory_write ツール経由でメモリファイルが書き出される |

### 6.2 モック境界

- LLM API 呼び出し → モック（テストで実 API を叩かない）
- pi-coding-agent SDK の SessionManager / createAgentSession → モック
- EventReader / ContextBuilder / MemoryReader → モック（s01 の実装に依存しない）
- CommandQueue → モック（isIdle / enqueueCommand）
- SystemEventQueue → モック（enqueueSystemEvent）
- タイマー → `node:timers/promises` の mock
- ファイルシステム（HEARTBEAT.md 等） → テスト用 tmpdir

---

## 7. 実装タスクリスト

### Phase 1: AgentRunner

- [ ] Test: SDK 利用手順 — lock → open → create → subscribe → dispose の順序が守られる (Red)
- [ ] Impl: AgentRunner 基本実装（SDK 6 ステップ） (Green)
- [ ] Test: メモリ書き込みガード — 明示トリガーありで memory_write が実行される (Red)
- [ ] Test: メモリ書き込みガード — 明示トリガーなしでは memory_write が実行されない (Red)
- [ ] Test: メモリ書き込みガード — `isHeartbeat=true` では memory_write がツールリストから常に除外される (Red)
- [ ] Test: メモリ再利用 — memory_write で保存した内容が次回ターンの入力コンテキストへ再注入される (Red)
- [ ] Test: ハートビート時の updatedAt 復元 — 実行後に元の値に戻る（並行更新時は Math.max） (Red)
- [ ] Impl: isHeartbeat フラグ処理 + 明示トリガー判定 (Green)
- [ ] Test: onTextDelta / onToolCall コールバック — ストリーミングイベントが正しく通知される (Red)
- [ ] Impl: 購読層とコールバック整形 (Green)
- [ ] Test: SDK セッション後処理 — 例外発生時も flush/dispose + ロック解放が確実に実行される (Red)
- [ ] Impl: finally ブロックでの後処理 (Green)
- [ ] Test: 一時失敗リトライ — 通信エラー時に 2.5 秒後 1 回再試行、成功/失敗の両方 (Red)
- [ ] Test: コンテキスト超過時の切り詰め再試行 — 入力を切り詰めて 1 回再試行 (Red)
- [ ] Impl: 失敗回復ロジック (Green)
- [ ] Test: LLM モデル利用不可 — 即座に失敗を返す (Red)
- [ ] Impl: モデル可用性チェック (Green)
- [ ] Test: セッションファイル破損 — 修復試行 → 修復不能時はファイル退避 + 新規作成 (Red)
- [ ] Impl: FR-AG-4 修復/退避ロジック (Green)
- [ ] Impl: memory_write ツール登録 + 明示トリガー判定実装（MemoryWriter 連携） (Green)
- [ ] Integration: AgentRunner + MemoryWriter 結合テスト

### Phase 2: HeartbeatRunner — 基本フロー

- [ ] Test: タイマー発火 — intervalMs 後に heartbeat タスクが実行される (Red)
- [ ] Impl: `startHeartbeat()` 基本ループ (Green)
- [ ] Test: 空ファイルスキップ — HEARTBEAT.md が実質空で `skipped(empty-heartbeat-file)` (Red)
- [ ] Impl: 実質空判定ロジック (Green)
- [ ] Test: HEARTBEAT_OK 判定 — stripHeartbeatToken でマークアップ正規化後、ackMaxChars 以下で `shouldSkip=true` (Red)
- [ ] Test: stripHeartbeatToken — HTML タグ除去、`&nbsp;` 変換、Markdown 修飾除去 (Red)
- [ ] Impl: stripHeartbeatToken + HEARTBEAT_OK 判定 (Green)
- [ ] Test: アラート生成 — 注目イベント時にアラートテキストが返り、onAlert が呼ばれる (Red)
- [ ] Test: アラート生成時に SystemEventQueue にチャットセッション向け要約が投入される (Red)
- [ ] Impl: アラート生成 + SEQ 投入 (Green)

### Phase 3: HeartbeatRunner — スキップ条件

- [ ] Test: quiet-hours スキップ — activeHours 時間外で `skipped(quiet-hours)` (Red)
- [ ] Test: activeHours 深夜跨ぎ（start > end）(Red)
- [ ] Impl: activeHours 判定ロジック (Green)
- [ ] Test: requests-in-flight スキップ — isIdle("main") が false で `skipped(requests-in-flight)` (Red)
- [ ] Test: requests-in-flight 短周期再試行 — retryDelayMs 後に再試行、maxRetries 超過で次周期待ち (Red)
- [ ] Impl: requests-in-flight + 再試行ロジック (Green)
- [ ] Test: readiness 失敗 — アラート配信前失敗時に `skipped(readiness-failed)` + EventPayload `skipped` (Red)
- [ ] Test: ok-token/ok-empty 可視化判定側 readiness 失敗 — `ran` + `ok-*` を維持 (Red)
- [ ] Impl: readiness 判定 + EventPayload 記録 (Green)
- [ ] Test: グループセッション指定時 — `skipped(group-session-disabled)` (Red)
- [ ] Impl: グループセッション判定 (Green)
- [ ] Test: showOk/showAlerts/useIndicator が全 false — `skipped(alerts-disabled)` でモデル呼び出しなし (Red)
- [ ] Impl: 可視性設定チェック（alerts-disabled） (Green)

### Phase 4: HeartbeatRunner — 重複排除 + Current time

- [ ] Test: 重複排除 — 24h 以内の同一テキストで `HeartbeatRunResult.status: "ran"` 維持 + `HeartbeatEventPayload.status: "skipped", reason: "duplicate"` (Red)
- [ ] Test: 重複排除 — ウィンドウ期限切れ後の再通知 (Red)
- [ ] Test: 重複排除 — lastHeartbeatText / lastHeartbeatSentAt の永続化（プロセス再起動後も有効） (Red)
- [ ] Impl: 重複排除ロジック (Green)
- [ ] Test: Current time 注入 — Body 末尾に `Current time: <formattedTime> (<userTimezone>)` が付与される (Red)
- [ ] Test: Current time 注入 — 既存 "Current time:" 行がある場合は重複挿入しない (Red)
- [ ] Impl: Current time 注入ロジック (Green)
- [ ] Test: HeartbeatRunRecord 記録 — 実行結果が監査用レコードとして保存される (Red)
- [ ] Impl: HeartbeatRunRecord 記録 (Green)
- [ ] Refactor: OpenClaw パターンとの整合確認

---

## 8. 完了の定義

### 8.1 機能 DoD

- [ ] AC-03: SDK 実行手順（lock→open→create→subscribe→dispose）を満たす
- [ ] AC-06: 一時失敗時の再試行/切り詰め再試行が機能する
- [ ] AC-07: HEARTBEAT_OK 抑制時に `ran` 維持 + `ok-*` ログが残る
- [ ] AC-08: Heartbeat アラートが通知される
- [ ] AC-09: HEARTBEAT.md 実質空で `skipped` になる
- [ ] AC-11: 明示指示時のみメモリ書き込みされ、Heartbeat 実行時は書き込まれない
- [ ] AC-12: SOUL.md が通常対話/Heartbeat の応答方針に反映される
- [ ] AC-16: 24h 同一 Heartbeat 本文が `duplicate` で抑制され `ran` を維持する
- [ ] AC-18: アラート配信前 readiness 失敗は `skipped` 記録、ok-token/ok-empty 側は `ran + ok-*` 維持
- [ ] AC-20: Heartbeat 送信 Body に Current time 行が重複なく注入される
- [ ] AC-22: requests-in-flight 時に skipped 記録 + 1 秒後再試行される
- [ ] P-03: グループセッション指定時は Heartbeat が group-session-disabled でスキップされる

### 8.2 品質 DoD

- [ ] 全ユニットテストがパスする
- [ ] `pnpm run typecheck` がエラーなし
- [ ] `pnpm run lint` がエラーなし

---

## 9. 懸念事項

- pi-coding-agent SDK のバージョンに強く依存する。SDK の API 変更時にこのプランのモジュールが直接影響を受ける
- HeartbeatRunner のテストケースが多い（~30 テスト）。Phase 2-4 を順に進め、各 Phase 完了時点で動作確認を入れることを推奨
- AgentRunner の FR-AG-4（セッションファイル破損修復）は SDK 内部の保存フォーマットに依存するため、修復ロジックの精度は SDK バージョンに左右される
- 重複排除の `lastHeartbeatText` / `lastHeartbeatSentAt` の永続化先は SessionStore に依存するが、s01 の SessionStore インターフェースに HeartbeatRunner 固有のフィールドを持たせるか、別ファイルに保存するかは実装時に判断する
