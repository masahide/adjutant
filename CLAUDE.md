# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクト概要

Adjutant は Slack Desktop の Chrome DevTools Protocol (CDP) からイベントを収集し、正規化した JSONL を日付単位で保存する Node.js ツール。TypeScript + ESM で構築。

## コマンド

```bash
pnpm install                # 依存インストール
pnpm start                  # 収集プロセス起動 (tsx src/index.ts)
pnpm dev                    # CDP 利用可否確認後に起動
pnpm run build:backend      # tsc コンパイル → dist/backend/
pnpm run serve              # dist/backend/index.js を運用モード起動（要 build:backend）
pnpm run assistant          # AI アシスタント起動（API + Web UI）
pnpm run typecheck          # 型チェック
pnpm run lint               # ESLint
pnpm run lint:fix           # ESLint 自動修正
pnpm run format             # Prettier チェック
pnpm run format:write       # Prettier 自動整形
pnpm run test               # 全テスト実行 (node --test)
pnpm run test:slack         # Slack 関連テストのみ
pnpm run check              # format → typecheck → test（PR 前に必ず実行）
```

単一テストの実行:

```bash
node --import tsx --test tests/jsonlWriter.test.ts
```

## アーキテクチャ

### Slack イベント収集パイプライン

```
CDP endpoint (Slack Desktop)
    ↓
src/runtime/slackConnection.ts  ← CDP 接続・再接続管理
    ↓
src/slack/adapter.ts            ← Fetch インターセプト / WebSocket フレーム処理 / 重複排除
    ↓
src/slack/normalize.ts          ← イベント正規化 (post / reaction / notification)
    ↓
src/pipeline/slackIngestor.ts   ← パイプライン統合
    ↓
src/io/jsonlWriter.ts           ← data/YYYY/MM/DD/slack/events.jsonl へ追記保存
```

### AI アシスタント（`src/assistant/` + `src/ui/`）

```
data/YYYY/MM/DD/slack/events.jsonl
    ↓
src/assistant/event-reader.ts        ← JSONL イベント読み込み
src/assistant/system-event-queue.ts  ← 外部トリガ FIFO キュー
src/assistant/memory-reader.ts       ← MEMORY.md / memory/YYYY-MM-DD.md 読み込み
    ↓
src/assistant/context-builder.ts     ← AI 向けプロンプト組み立て
    ↓
src/assistant/command-queue.ts       ← main + session レーン排他制御
src/assistant/chat-handler.ts        ← チャット受理・冪等判定・パイプライン統合
    ↓
src/assistant/api-server.ts          ← HTTP API + SSE ストリーミング（:3100）
    ↓
src/ui/                              ← @assistant-ui/react ベース Web UI（Vite :5173）
```

### 主要モジュール

- **`src/index.ts`** — エントリポイント。セッション管理、シグナルハンドリング、リトライ（指数バックオフ）
- **`src/core/events.ts`** — `NormalizedEvent` 型定義（スキーマ `adjutant.event.v1.1`）。`IngestionAdapter` インターフェースは `src/core/adapter.ts`
- **`src/slack/`** — Slack アダプタ群。DOM キャプチャ（`domCaptureService.ts`）、レスポンスボディ読み取り（`responseBodyReader.ts`）、チャンネル/ユーザー名キャッシュ（`nameCacheRepository.ts`）
- **`src/runtime/config.ts`** — 設定解決（CDP エンドポイント、データディレクトリ、環境変数）
- **`src/io/`** — JSONL ライター、CDP 生イベントログ、fetch デバッグログ
- **`src/debug/debugUi.ts`** — SSE ベースのデバッグサーバー
- **`src/assistant/`** — AI アシスタント基盤。データ読み込み、キュー制御、API サーバー、チャットハンドラ
- **`src/ui/`** — Web UI。Thread + Composer + HeartbeatIndicator（`@assistant-ui/react`）

### イベント UID 規則

- post: `slack:{channel_id}@{message_ts}`
- reaction: `slack:{channel_id}@{message_ts}:{emoji}:{action}:{actorId}`
- notification: `slack:{channel_id}@{event_ts or now}:{notification_type}:{actorId}`

### 出力先

- イベント: `data/YYYY/MM/DD/slack/events.jsonl`
- キャッシュ: `data/_cache/slack/{channel,user}-names-by-team/<team_id>.json`
- デバッグ: `data/_debug/{cdp-events,raw-fetch}.jsonl`

### AI アシスタント環境変数

| 変数名                           | デフォルト           | 説明                                   |
| -------------------------------- | -------------------- | -------------------------------------- |
| `ADJUTANT_API_PORT`              | `3100`               | API サーバーポート                     |
| `ADJUTANT_API_HOST`              | `127.0.0.1`          | API サーバーホスト                     |
| `ADJUTANT_DATA_DIR`              | `data`               | データディレクトリ                     |
| `ADJUTANT_WORKSPACE_DIR`         | `$ADJUTANT_DATA_DIR` | ワークスペースディレクトリ             |
| `ADJUTANT_TZ`                    | `Asia/Tokyo`         | タイムゾーン                           |
| `ADJUTANT_MODEL`                 | (SDK デフォルト)     | LLM モデル指定 (`provider/model` 形式) |
| `ADJUTANT_HEARTBEAT_INTERVAL_MS` | `1800000` (30分)     | ハートビート間隔                       |
| `ADJUTANT_VITE_PORT`             | `5173`               | Vite dev server ポート                 |
| `PI_CACHE_RETENTION`             | `long` (自動設定)    | プロンプトキャッシュ保持期間           |

**モデル指定例:** `ADJUTANT_MODEL=openai/gpt-4o`, `ADJUTANT_MODEL=anthropic/claude-sonnet-4-20250514`

**API 選択:** pi-coding-agent SDK がモデル定義に基づき自動選択（OpenAI は Responses API、Codex はセッションキャッシュ付き）。Codex モデル指定時は `sessionId` が自動伝搬される。

## テスト

Node.js 標準 `--test` モジュールを使用（Vitest/Jest ではない）。テストは `tests/` 配下。テスト内では `node:test` の `describe`, `it`, `mock` を使用する。

## コーディング規約

- ESM モジュール、TypeScript strict モード
- Prettier: ダブルクォート、トレイリングカンマ es5、printWidth 100
- ESLint: `@typescript-eslint` 有効、`_` プレフィックスで未使用引数を許可
- 命名: camelCase（変数/関数）、PascalCase（型/クラス）、UPPER_SNAKE_CASE（定数）
- default export ではなく named export を使用

## コミット規約

Conventional Commits: `feat:`, `fix:`, `chore:`, `refactor:`, `docs:` など。命令形、72文字以内。

## 開発方針

- Prototype First: 後方互換性は考慮しない（特別な指示がない限り）
- TDD Red-Green-Refactor サイクルに従う
- 仕様が曖昧な場合は勝手に補完せず確認する
- 計画書は `doc/plan/YYMMDD-s{連番}-{実装名}.md` に作成（`doc/AI_PLANNINGAI_GUIDE.md` 参照）
