# s06: main.ts 実モジュール結合計画

## 概要

s01（データ・キュー基盤）、s02（AI 実行層）、s03（API + UI）の 3 レイヤーは個別に実装・テスト済み（183 テスト合格）。
`src/assistant/main.ts` のスタブ AgentRunner を実モジュールに置き換え、HeartbeatRunner を統合し、MVP アシスタントをエンドツーエンドで動作可能にする。

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
- `pnpm run check` で全テストパス
