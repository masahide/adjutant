# s06: main.ts 実モジュール結合計画

## 概要

s01（データ・キュー基盤）、s02（AI 実行層）、s03（API + UI）の 3 レイヤーは個別に実装・テスト済み（183 テスト合格）。
`src/assistant/main.ts` のスタブ AgentRunner を実モジュールに置き換え、HeartbeatRunner を統合し、MVP アシスタントをエンドツーエンドで動作可能にする。

## 進捗チェック

- [x] runId フォーマット変更（OpenClaw 準拠）
- [x] アダプタ関数（`createAgentRunAdapter`）実装
- [x] HeartbeatRunner 統合（`startHeartbeat` + `heartbeatProvider` 接続）
- [x] グレースフルシャットダウン（`heartbeatHandle.stop()` + `api.stop()` + `viteChild?.kill()`）
- [x] `tests/assistant/main-adapter.test.ts` 作成
- [x] 既存 runId アサーション更新（`runId = idempotencyKey`, `storeKey = sessionKey:idempotencyKey`）
- [ ] `pnpm run check` 全体通過

補足:

- `node --import tsx --test tests/assistant/idempotency-registry.test.ts tests/assistant/chat-handler.test.ts tests/assistant/main-adapter.test.ts` は通過済み。
- `pnpm run check` は現時点で `prettier --check`（`doc/reference/openclaw/ext-plan.md`, `doc/reference/openclaw/session-plan.md`, `doc/plan/260217-s01-openclaw-proactive-gateway-integration.md`）で停止し、全体完走できない。

## 変更内容

### 1. runId フォーマット変更（OpenClaw 準拠）

- `runId = idempotencyKey`（`sessionKey:idempotencyKey` から変更）
- 内部重複排除キーは `storeKey = ${sessionKey}:${idempotencyKey}` で維持
- `DedupResult` に `storeKey` フィールド追加
- `updateStatus` は `storeKey` を受け取るよう変更

### 2. アダプタ関数（`createAgentRunAdapter`）

- `AgentRunner.runAgent` → `ChatHandler.AgentRunFn` のブリッジ
- `onTextDelta` → `onDelta({ state: "delta" })` 変換
- 正常完了時 `onDelta({ state: "final" })` + `{ status: "completed" }`
- エラー時 `{ status: "failed", reason }` 返却

### 3. HeartbeatRunner 統合

- `startHeartbeat` + `heartbeatProvider` を `createApiServer` に接続
- 環境変数: `ADJUTANT_MODEL`, `ADJUTANT_HEARTBEAT_INTERVAL_MS`

### 4. グレースフルシャットダウン

- `heartbeatHandle.stop()` + `api.stop()` + `viteChild?.kill()`

## テスト

- `tests/assistant/main-adapter.test.ts` 新規作成
- 既存テストの runId アサーション更新
- `pnpm run check` は実行済み（現状は `prettier --check` 段階で停止）
