# Adjutant

Slack Desktop の Chrome DevTools Protocol (CDP) からイベントを収集し、正規化した JSONL を日付単位で保存する Node.js ツールです。収集したイベントを AI が読み込み、プロアクティブに動作するパーソナルアシスタント機能も提供します。

## 現在の実装範囲

- Slack CDP への接続と自動再接続 (`src/index.ts`)
- `chat.postMessage` / `reactions.*` の正規化 (`src/slack/`)
- WebSocket 通知の一部正規化（`kind=notification`）
- 日付パーティション JSONL 追記保存 (`src/io/jsonlWriter.ts`)
- チャンネル名・ユーザー名の team 単位キャッシュ (`data/_cache/slack/`)
- オプションの Debug UI (`ADJUTANT_DEBUG_UI=1`)
- AI アシスタント: HTTP API + SSE ストリーミング + Web UI (`src/assistant/`, `src/ui/`)
- Slack通知の一次判定（`TriggerFilter.secondaryClassifier`）に OpenAI 軽量モデルを接続可能

GitHub / ローカル Git 収集は未実装で、仕様メモは `doc/spec.md` にあります。日次 Markdown 要約は `ADJUTANT_MARKDOWN_SUMMARY_BATCH_ENABLED=1` で有効化できます。
bash ツールの Docker サンドボックス実行は `ADJUTANT_SANDBOX_MODE=non-main|all` で有効化できます（既定 `off`）。

日次 Markdown 要約バッチの実装挙動（抜粋）は次のとおりです。

- 実行は単一 in-flight（前回実行中の tick は skip）
- checkpoint キーは絶対パスではなく相対安定キー（`state:<relpath>`）
- `maxSessions` 上限時は未処理/古いもの優先で巡回（飢餓回避）
- transcript truncate/rotate（サイズ縮小）時は offset を自動リセットして再走査
- JSONL 最終行が改行なしでも処理

## ディレクトリ構成

```text
src/            # ランタイム本体 (TypeScript)
src/assistant/  # AI アシスタント基盤（API サーバー、チャットハンドラ、データ読み込み）
src/ui/         # Web UI（@assistant-ui/react）
scripts/        # 開発起動・運用起動ヘルパー
hack/           # Slack/CDP 補助スクリプト
doc/            # 設計仕様
tests/          # node --test 用テスト
```

## セットアップ

```bash
pnpm install
```

## 主なコマンド

```bash
pnpm start               # 収集プロセスを起動 (tsx src/index.ts)
pnpm dev                 # CDP 利用可否を確認して pnpm start を起動
pnpm run build:backend   # dist/backend/index.js をビルド
pnpm run serve           # dist/backend/index.js を運用モード起動
pnpm run sandbox:build   # sandbox 用 Docker イメージをビルド
pnpm run typecheck
pnpm run lint
pnpm run format
pnpm run test
pnpm check               # format -> typecheck -> test
```

`pnpm run serve` は `dist/backend/index.js` を実行するため、事前に `pnpm run build:backend` が必要です。

## 実行時設定

| 変数                                           | 既定値                                               | 用途                                                                    |
| ---------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------- |
| `CDP_HOST`                                     | `127.0.0.1`                                          | CDP 接続先ホスト                                                        |
| `CDP_PORT`                                     | `9222`                                               | CDP 接続先ポート                                                        |
| `CDP_ENDPOINT_FILE`                            | `.adjutant/cdp-endpoint.json`                        | 接続先上書き JSON (`host`, `port`)                                      |
| `DATA_DIR`                                     | `./data`                                             | JSONL 保存ルート                                                        |
| `ADJUTANT_TZ`                                  | `Asia/Tokyo`                                         | 正規化イベントのタイムゾーン                                            |
| `ADJUTANT_DEBUG`                               | -                                                    | Slack アダプタ詳細ログ (`slack:verbose` など)                           |
| `ADJUTANT_DISABLE_DOM_CAPTURE`                 | `0`                                                  | リアクション時 DOM キャプチャ無効化                                     |
| `ADJUTANT_DEBUG_UI`                            | `0`                                                  | Debug UI (`http://127.0.0.1:8787`) を有効化                             |
| `ADJUTANT_DEBUG_UI_PORT`                       | `8787`                                               | Debug UI ポート                                                         |
| `ADJUTANT_CDP_EVENT_LOG`                       | `0`                                                  | CDP 生イベントを JSONL へ保存                                           |
| `ADJUTANT_CDP_EVENT_LOG_PATH`                  | `<dataDir>/_debug/cdp-events.jsonl`                  | CDP 生イベントの出力先                                                  |
| `ADJUTANT_CDP_EVENT_LOG_MAX_PARAM_CHARS`       | `0`                                                  | params を文字列化して上限超過時に切り詰め (`0` は無制限)                |
| `ADJUTANT_RAW_FETCH_LOG`                       | `0`                                                  | `raw_fetch` デバッグイベントを JSONL へ保存（内部 fetch hook も有効化） |
| `ADJUTANT_RAW_FETCH_LOG_PATH`                  | `<dataDir>/_debug/raw-fetch.jsonl`                   | `raw_fetch` イベントの出力先                                            |
| `ADJUTANT_RAW_FETCH_LOG_MAX_PAYLOAD_CHARS`     | `0`                                                  | payload を文字列化して上限超過時に切り詰め (`0` は無制限)               |
| `ADJUTANT_API_PORT`                            | `3100`                                               | AI アシスタント API サーバーのポート                                    |
| `ADJUTANT_API_HOST`                            | `127.0.0.1`                                          | AI アシスタント API サーバーのバインドアドレス                          |
| `ADJUTANT_VITE_PORT`                           | `5173`                                               | AI アシスタント Web UI（Vite）のポート                                  |
| `ADJUTANT_WORKSPACE_DIR`                       | `<stateDir>/workspace`                               | アシスタントのワークスペースディレクトリ                                |
| `ADJUTANT_STATE_DIR`                           | `~/.adjutant`                                        | アシスタント state ルート（session transcript / watermark など）        |
| `ADJUTANT_SESSION_AGENT_ID`                    | `main`                                               | session 保存先を切る agent ID                                           |
| `ADJUTANT_SESSION_TRANSCRIPTS_DIR`             | `<stateDir>/agents/<agentId>/sessions`               | session JSONL 保存先 override                                           |
| `ADJUTANT_SESSION_ENTRIES_PATH`                | `<stateDir>/agents/<agentId>/sessions/sessions.json` | セッションメタ情報（`sessionId`, `sessionFile`）保存先                  |
| `ADJUTANT_MARKDOWN_SUMMARY_BATCH_ENABLED`      | `0`                                                  | 日次 Markdown 要約バッチを有効化                                        |
| `ADJUTANT_MARKDOWN_SUMMARY_BATCH_INTERVAL_MS`  | `3600000`                                            | 要約バッチ実行間隔（ミリ秒）                                            |
| `ADJUTANT_MARKDOWN_SUMMARY_BATCH_MESSAGES`     | `15`                                                 | 1セッションから採用する末尾メッセージ数                                 |
| `ADJUTANT_MARKDOWN_SUMMARY_BATCH_MAX_SESSIONS` | `200`                                                | 1 tick あたり最大処理セッション数                                       |
| `ADJUTANT_ROUTE_LLM_ENABLED`                   | `0`                                                  | Slack通知の一次判定に OpenAI route LLM を使うかどうか                   |
| `ADJUTANT_ROUTE_LLM_MODEL`                     | `gpt-5-mini`                                         | route LLM に使用する OpenAI モデル名                                    |
| `ADJUTANT_ROUTE_LLM_TIMEOUT_MS`                | `1000`                                               | route LLM 判定のタイムアウト（ミリ秒）                                  |
| `ADJUTANT_ROUTE_LLM_MAX_CONCURRENT`            | `1`                                                  | route LLM 判定の同時実行上限（1で逐次）                                 |
| `ADJUTANT_SANDBOX_MODE`                        | `off`                                                | bash sandbox mode（`off` / `non-main` / `all`）                         |
| `ADJUTANT_SANDBOX_IMAGE`                       | `adjutant-sandbox:trixie-slim`                       | sandbox Docker image                                                    |
| `ADJUTANT_SANDBOX_CONTAINER_PREFIX`            | `adjutant-sandbox`                                   | sandbox container 名の prefix                                           |
| `ADJUTANT_SANDBOX_WORKDIR`                     | `/workspace`                                         | コンテナ内作業ディレクトリ                                              |
| `ADJUTANT_SANDBOX_NETWORK`                     | 未設定（bridge）                                     | Docker network（例: `none`）                                            |
| `ADJUTANT_SANDBOX_MEMORY`                      | 未設定                                               | Docker memory limit（例: `1g`）                                         |
| `ADJUTANT_SANDBOX_PIDS_LIMIT`                  | `256`                                                | Docker pids limit                                                       |
| `OPENAI_API_KEY`                               | -                                                    | route LLM 有効時に利用する OpenAI API キー                              |

## Bash sandbox（Docker）

```bash
pnpm run sandbox:build
ADJUTANT_SANDBOX_MODE=all pnpm start
```

- `off`: ホスト実行（既定）
- `non-main`: main 以外（spoke）のみコンテナ実行
- `all`: heartbeat を除く全セッションをコンテナ実行
- sandbox イメージには `bash` / `git` / `curl` / `jq` / `rg`（ripgrep）を同梱
- Docker 利用不可またはイメージ未ビルド時は fail-safe で起動中断します

## AI セッションコンテキスト方針

- 会話履歴の復元は `SessionManager.buildSessionContext()` に委譲します。
- `ChatHandler` は transcript/memory を再注入せず、`system event`（ある場合）+ `## User Message` のみを送信します。
- `/api/chat/history` は UI 表示用途として transcript-reader の読み出し結果を返します。

## 出力

```text
data/
  YYYY/MM/DD/
    slack/
      events.jsonl
```

キャッシュは以下に保存されます。

```text
data/_cache/slack/
  channel-names-by-team/<team_id>.json
  user-names-by-team/<team_id>.json
data/_debug/
  cdp-events.jsonl
  raw-fetch.jsonl
```

`user-names-by-team/<team_id>.json` は以下のように保存されます（`adjutant.slack.user-cache.v2`）。

```json
{
  "schema": "adjutant.slack.user-cache.v2",
  "updated_at": "2026-02-12T01:32:31.449Z",
  "team_id": "T12345678",
  "users": {
    "U123": {
      "real_name": "Taro Yamada",
      "profile": {
        "display_name": "taro",
        "email": "taro@example.com",
        "first_name": "Taro",
        "last_name": "Yamada",
        "image_original": "https://..."
      }
    }
  }
}
```

## デバッグ例

```bash
ADJUTANT_DEBUG=slack:verbose,slack:domprobe pnpm start
ADJUTANT_DEBUG_UI=1 ADJUTANT_DEBUG=slack:fetch:hook pnpm start
ADJUTANT_CDP_EVENT_LOG=1 ADJUTANT_CDP_EVENT_LOG_MAX_PARAM_CHARS=20000 pnpm start
ADJUTANT_RAW_FETCH_LOG=1 ADJUTANT_RAW_FETCH_LOG_MAX_PAYLOAD_CHARS=20000 pnpm start
ADJUTANT_DISABLE_DOM_CAPTURE=1 pnpm start
```

## 注意点

- リアクション本文取得は DOM キャプチャ依存です。対象メッセージが画面上にない場合、本文を補完できないことがあります。
- DOM キャプチャは `/api/reactions.*` の POST を起点に動作し、他ユーザー由来の WebSocket 通知だけでは発火しません。
- デバッグログには機密情報が含まれる可能性があるため、共有前に必ずマスクしてください。

## ACP 実装プロファイル（s02）

現時点の `agent-worker-acp` は最小プロファイルで動作します。

- stable 対応: `initialize`, `authenticate`, `session/new`, `session/load`（capability有効時）, `session/prompt`, `session/cancel`, `session/update`
- unstable: `session/list`, `session/resume`, `session/fork`, `session/set_model`（feature flag で隔離、既定無効）
- v1 非スコープ: FS capability（`fs/read_text_file`, `fs/write_text_file`）と terminal gateway 一式

stdio 起動例:

```bash
node --import tsx src/agent-worker-acp/stdio-server.ts
```
