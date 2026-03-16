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

GitHub / ローカル Git 収集は未実装です。仕様の入口は [doc/spec/README.md](/Users/USER/masahide/git/adjutant/doc/spec/README.md) を参照してください。日次 Markdown 要約は `ADJUTANT_MARKDOWN_SUMMARY_BATCH_ENABLED=1` で有効化できます。
Docker sandbox は既定で有効です（`ADJUTANT_SANDBOX_MODE=all`）。sandbox 対象では `bash` に加えて `read` / `edit` / `write` / `grep` / `find` / `ls` もコンテナ実行されます。custom tool 公開面は `tool_hub` に統一されています。

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
cp .env.example .env.local
```

リポジトリ直下の `.env` と `.env.local` は、実行エントリから自動で読み込まれます。優先順位は次の通りです。

1. すでに `export` 済みの環境変数
2. `.env.local`
3. `.env`

実行時に必要な固有情報は `.env.local` に置いてください。`.env` / `.env.local` は Git 管理外です。

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
pnpm run test:no-docker     # Docker なし環境向け（integration の sandbox を無効化）
pnpm run verify:config-doc-sync
pnpm check               # format -> typecheck -> test
```

`pnpm run serve` は `dist/backend/index.js` を実行するため、事前に `pnpm run build:backend` が必要です。

## 実行時設定

| 変数                                           | 既定値                                               | 用途                                                                                  |
| ---------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `CDP_HOST`                                     | `127.0.0.1`                                          | CDP 接続先ホスト                                                                      |
| `CDP_PORT`                                     | `9222`                                               | CDP 接続先ポート                                                                      |
| `CDP_ENDPOINT_FILE`                            | `.adjutant/cdp-endpoint.json`                        | 接続先上書き JSON (`host`, `port`)                                                    |
| `ADJUTANT_COLLECTOR_SLACK_ENABLED`             | `0`                                                  | `collector-slack` 子プロセス起動フラグ（Phase C 準備）                                |
| `ADJUTANT_COLLECTOR_SLACK_ENTRY`               | `src/collector-slack/main.ts`                        | `collector-slack` エントリポイント（Phase C 準備）                                    |
| `DATA_DIR`                                     | `./data`                                             | JSONL 保存ルート                                                                      |
| `ADJUTANT_DATA_DIR`                            | `<stateDir>/data`                                    | collector 保存ルート（`DATA_DIR` より優先）                                           |
| `ADJUTANT_SLACK_ACCOUNT_ID`                    | `default`                                            | Slack 保存先 account_id                                                               |
| `ADJUTANT_SLACK_SELF_USER_IDS`                 | -                                                    | カンマ区切りの self user id 一覧。direct mention 判定と raw log 解析で使用            |
| `ADJUTANT_SLACK_WORKSPACE_HOSTS`               | -                                                    | `teamId=workspaceHost` の CSV。permalink 生成時の workspace host override             |
| `ADJUTANT_SLACK_WORKSPACE_HOST`                | -                                                    | raw log 解析時の単一 workspace host override                                          |
| `ADJUTANT_TZ`                                  | `Asia/Tokyo`                                         | 正規化イベントのタイムゾーン                                                          |
| `ADJUTANT_DEBUG`                               | -                                                    | Slack アダプタ詳細ログ (`slack:verbose` など)                                         |
| `ADJUTANT_DISABLE_DOM_CAPTURE`                 | `0`                                                  | リアクション時 DOM キャプチャ無効化                                                   |
| `ADJUTANT_DEBUG_UI`                            | `0`                                                  | Debug UI (`http://127.0.0.1:8787`) を有効化                                           |
| `ADJUTANT_DEBUG_UI_PORT`                       | `8787`                                               | Debug UI ポート                                                                       |
| `ADJUTANT_CDP_EVENT_LOG`                       | `0`                                                  | CDP 生イベントを JSONL へ保存                                                         |
| `ADJUTANT_CDP_EVENT_LOG_PATH`                  | `<dataDir>/_debug/cdp-events.jsonl`                  | CDP 生イベントの出力先                                                                |
| `ADJUTANT_CDP_EVENT_LOG_MAX_PARAM_CHARS`       | `0`                                                  | params を文字列化して上限超過時に切り詰め (`0` は無制限)                              |
| `ADJUTANT_RAW_FETCH_LOG`                       | `0`                                                  | `raw_fetch` デバッグイベントを JSONL へ保存（内部 fetch hook も有効化）               |
| `ADJUTANT_RAW_FETCH_LOG_PATH`                  | `<dataDir>/_debug/raw-fetch.jsonl`                   | `raw_fetch` イベントの出力先                                                          |
| `ADJUTANT_RAW_LOG_PATH`                        | `<dataDir>/_debug/slack-debug.jsonl`                 | raw debug capture / analyze 用の統合ログ出力先                                        |
| `ADJUTANT_RAW_FETCH_LOG_MAX_PAYLOAD_CHARS`     | `"20000"`                                            | payload を文字列化して上限超過時に切り詰める既定文字数                                |
| `ADJUTANT_CONTROL_PLANE_PORT`                  | `3100`                                               | control-plane API サーバーのポート                                                    |
| `ADJUTANT_CONTROL_PLANE_HOST`                  | `127.0.0.1`                                          | control-plane API サーバーのバインドアドレス                                          |
| `ADJUTANT_VITE_PORT`                           | `5173`                                               | AI アシスタント Web UI（Vite）のポート                                                |
| `ADJUTANT_DELIVER_SLACK_ENABLED`               | `0`                                                  | `deliver-slack` 子プロセス起動フラグ                                                  |
| `ADJUTANT_DELIVER_SLACK_ENTRY`                 | `src/deliver-slack/stdio-server.ts`                  | `deliver-slack` エントリポイント                                                      |
| `ADJUTANT_DELIVER_SLACK_AUTO_COMPLETE`         | `1`                                                  | `deliver/enqueue` 受理後に `deliver/completed` を自動通知する                         |
| `ADJUTANT_DELIVER_SLACK_COMPLETION_DELAY_MS`   | `5`                                                  | 自動 completion 通知までの遅延（ミリ秒）                                              |
| `ADJUTANT_DELIVER_SLACK_SIMULATE_FAILURE`      | `0`                                                  | 自動 completion を `failed` 扱いで通知する（テスト/障害注入用）                       |
| `ADJUTANT_WORKSPACE_DIR`                       | `<stateDir>/workspace`                               | アシスタントのワークスペースディレクトリ                                              |
| `ADJUTANT_STATE_DIR`                           | `~/.adjutant`                                        | アシスタント state ルート（session transcript / watermark など）                      |
| `ADJUTANT_SESSION_AGENT_ID`                    | `main`                                               | session 保存先を切る agent ID                                                         |
| `ADJUTANT_SESSION_TRANSCRIPTS_DIR`             | `<stateDir>/agents/<agentId>/sessions`               | session JSONL 保存先 override                                                         |
| `ADJUTANT_SESSION_ENTRIES_PATH`                | `<stateDir>/agents/<agentId>/sessions/sessions.json` | セッションメタ情報（`sessionId`, `sessionFile`）保存先                                |
| `ADJUTANT_MARKDOWN_SUMMARY_BATCH_ENABLED`      | `0`                                                  | 日次 Markdown 要約バッチを有効化                                                      |
| `ADJUTANT_MARKDOWN_SUMMARY_BATCH_INTERVAL_MS`  | `3600000`                                            | 要約バッチ実行間隔（ミリ秒）                                                          |
| `ADJUTANT_MARKDOWN_SUMMARY_BATCH_MESSAGES`     | `15`                                                 | 1セッションから採用する末尾メッセージ数                                               |
| `ADJUTANT_MARKDOWN_SUMMARY_BATCH_MAX_SESSIONS` | `200`                                                | 1 tick あたり最大処理セッション数                                                     |
| `ADJUTANT_MARKDOWN_SUMMARY_BATCH_TIMEZONE`     | `UTC`                                                | summary batch の集計タイムゾーン                                                      |
| `ADJUTANT_FLUSHER_ENABLED`                     | `1`                                                  | pending flusher の有効化                                                              |
| `ADJUTANT_FLUSHER_INTERVAL_MS`                 | `60000`                                              | pending flusher 実行間隔（ミリ秒）                                                    |
| `ADJUTANT_FLUSHER_STALE_MS`                    | `900000`                                             | stale open post 判定閾値（ミリ秒）                                                    |
| `ADJUTANT_HEARTBEAT_ENABLED`                   | `1`                                                  | heartbeat 定期実行の有効化                                                            |
| `ADJUTANT_HEARTBEAT_INTERVAL_MS`               | `1800000`                                            | heartbeat 実行間隔（ミリ秒）                                                          |
| `ADJUTANT_HEARTBEAT_TIMEOUT_MS`                | `30000`                                              | heartbeat run のタイムアウト（ミリ秒）                                                |
| `ADJUTANT_HEARTBEAT_FILE_PATH`                 | `<workspaceDir>/HEARTBEAT.md`                        | heartbeat prompt の読み込みパス                                                       |
| `ADJUTANT_ROUTE_LLM_ENABLED`                   | `0`                                                  | Slack通知の一次判定に OpenAI route LLM を使うかどうか                                 |
| `ADJUTANT_ROUTE_LLM_MODEL`                     | `gpt-5-mini`                                         | route LLM に使用する OpenAI モデル名                                                  |
| `ADJUTANT_ROUTE_LLM_TIMEOUT_MS`                | `1000`                                               | route LLM 判定のタイムアウト（ミリ秒）                                                |
| `ADJUTANT_ROUTE_LLM_MAX_CONCURRENT`            | `1`                                                  | route LLM 判定の同時実行上限（1で逐次）                                               |
| `ADJUTANT_SANDBOX_MODE`                        | `all`                                                | bash sandbox mode（`off` / `non-main` / `all`）                                       |
| `ADJUTANT_SANDBOX_IMAGE`                       | `adjutant-sandbox:trixie-slim`                       | sandbox Docker image                                                                  |
| `ADJUTANT_SANDBOX_AUTO_BUILD_IMAGE`            | `true`                                               | sandbox image が未存在時に自動 build                                                  |
| `ADJUTANT_SANDBOX_HOME`                        | `/home/agent`                                        | sandbox 内 `HOME`。tmpfs で割り当てる                                                 |
| `ADJUTANT_SANDBOX_USER`                        | `<host uid>:<host gid>` または `1000:1000`           | sandbox 実行ユーザー。未指定時は POSIX でホスト UID/GID を使い、不可なら `1000:1000`  |
| `ADJUTANT_SANDBOX_WORKDIR`                     | `/workspace`                                         | コンテナ内作業ディレクトリ                                                            |
| `ADJUTANT_SANDBOX_ENV_ALLOWLIST`               | `LANG,LC_ALL,TERM,TZ`                                | sandbox へ受け渡す環境変数 allowlist                                                  |
| `ADJUTANT_SANDBOX_NETWORK`                     | `none`                                               | Docker network                                                                        |
| `ADJUTANT_SANDBOX_MEMORY`                      | 未設定                                               | Docker memory limit（例: `1g`）                                                       |
| `ADJUTANT_SANDBOX_PIDS_LIMIT`                  | `256`                                                | Docker pids limit                                                                     |
| `PLAY_SLACK_SEARCH_SESSION`                    | `slack`                                              | `play-slack-search` adapter が使う playwright-cli セッション名                        |
| `PLAY_SLACK_SEARCH_PROFILE`                    | playwright-cli の既定 profile                        | `play-slack-search` adapter が使う browser profile path                               |
| `PLAY_SLACK_SEARCH_WORKSPACE_URL`              | -                                                    | `play_slack_search` が request/permalink から workspace を解決できない場合の fallback |
| `OPENAI_API_KEY`                               | -                                                    | route LLM と thread title 生成に利用する OpenAI API キー                              |

`tool_hub(provider=slack, action=search)` が内部で使う `play-slack-search` adapter は、`workspaceUrl` を request で受けるか、notification の `permalink` から workspace を解決します。`PLAY_SLACK_SEARCH_WORKSPACE_URL` はそのどちらも使えない場合の最後の fallback です。複数 workspace 運用では、この環境変数に依存せず、collector が保持する `workspace_host` / `permalink` を優先させてください。

## Tool sandbox（Docker）

```bash
pnpm run sandbox:build
pnpm start
```

- `off`: ホスト実行
- `non-main`: main 以外（spoke）のみコンテナ実行
- `all`: heartbeat を除く全セッションで `bash` と標準ファイルツールをコンテナ実行
- 実行方式は tool 呼び出しごとの `docker run --rm`（常駐コンテナは使わない）
- sandbox には `--pull=never`, `--init`, `--read-only`, `--network=bridge` を既定で付与し、`ADJUTANT_SANDBOX_NETWORK=none` 指定時はネットワーク遮断で起動する。加えて `--cap-drop=ALL`, `--security-opt no-new-privileges=true`, `--security-opt seccomp=builtin`, `--ipc=private`, `--cgroupns=private`, `--hostname=sandbox` を付与
- workspace は `/workspace` に bind mount し、`HOME=/home/agent` は uid/gid を合わせた tmpfs を割り当てる
- `ADJUTANT_SANDBOX_USER` 未指定時は POSIX でホスト UID/GID を使い、取得できない環境では `1000:1000` に fallback する
- `read` / `edit` / `write` / `grep` / `find` / `ls` も `SandboxRunSpec` を共有し、workspace 外 path は拒否する
- custom tool 公開面は `tool_hub` 1 本のみで、`slack/search`, `slack/list-users`, `slack/resolve-channel-id`, `slack/save-users`, `memory/search`, `memory/get`, `memory/write` を provider/action として dispatch する
- Mac の Docker Desktop では root 所有問題が見えにくいことがありますが、設計基準は WSL の Linux filesystem 側と将来の Linux 実行です
- 既定 sandbox イメージには `bash` / `git` / `curl` / `jq` / `python3` / `python3-pip` / `rg`（ripgrep）を同梱
- Docker 利用不可またはイメージ未ビルド時は fail-safe で起動中断します
- WSL2 では workspace を `/mnt/c/...` ではなく Linux filesystem 側へ置くことを推奨します

## AI セッションコンテキスト方針

- assistant workspace の既定値は `~/.adjutant/workspace` です。`ADJUTANT_WORKSPACE_DIR` 未指定時は `<stateDir>/workspace` に解決されます
- bootstrap seed は `assistant/prompts` の `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, `BOOTSTRAP.md` を使います（`vendor/openclaw/docs/reference/templates` の取り込み元を repo 管理下へ複製）
- main session の Project Context には `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, `BOOTSTRAP.md`, `MEMORY.md` を注入し、`memory/YYYY-MM-DD.md` は自動注入しません
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
pnpm rawlog:capture
```

raw fetch log を使った notification payload 検証の準備:

```bash
pnpm rawlog:prepare
pnpm rawlog:capture
pnpm rawlog:analyze
```

詳細手順は [doc/runbook/raw-fetch-notification-validation.md](doc/runbook/raw-fetch-notification-validation.md) を参照。

補足:

- `pnpm rawlog:capture` は collector 系の補助コマンドで、通常は sandbox を経由しません。
- `pnpm start` は既定で sandbox 初期化を行うため、Docker 利用不可環境では `ADJUTANT_SANDBOX_MODE=off` か `ADJUTANT_TEST_NO_DOCKER=1` を明示してください。

## 注意点

- リアクション本文取得は DOM キャプチャ依存です。対象メッセージが画面上にない場合、本文を補完できないことがあります。
- DOM キャプチャは `/api/reactions.*` の POST を起点に動作し、他ユーザー由来の WebSocket 通知だけでは発火しません。
- デバッグログには機密情報が含まれる可能性があるため、共有前に必ずマスクしてください。

## ACP 実装プロファイル（s02）

現時点の `agent-worker-acp` は最小プロファイルで動作します。

- stable 対応: `initialize`, `authenticate`, `session/new`, `session/load`（capability有効時）, `session/prompt`, `session/cancel`, `session/update`
- unstable: `session/list`, `session/resume`, `session/fork`, `session/set_model`（feature flag で隔離、既定無効）
- v1 非スコープ: FS capability（`fs/read_text_file`, `fs/write_text_file`）と terminal gateway 一式
- 実行制約: 異なる `sessionId` は並行実行可能、同一 `sessionId` の同時 `session/prompt` は `SESSION_BUSY` で拒否
- エラー契約: 未知 `sessionId` は `INVALID_RECORD` を返却

stdio 起動例:

```bash
node --import tsx src/agent-worker-acp/stdio-server.ts
```
