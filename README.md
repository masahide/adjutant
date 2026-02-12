# Adjutant

Slack Desktop の Chrome DevTools Protocol (CDP) からイベントを収集し、正規化した JSONL を日付単位で保存する Node.js ツールです。

## 現在の実装範囲

- Slack CDP への接続と自動再接続 (`src/index.ts`)
- `chat.postMessage` / `reactions.*` の正規化 (`src/slack/`)
- WebSocket 通知の一部正規化（`kind=notification`）
- 日付パーティション JSONL 追記保存 (`src/io/jsonlWriter.ts`)
- チャンネル名・ユーザー名の team 単位キャッシュ (`data/_cache/slack/`)
- オプションの Debug UI (`ADJUTANT_DEBUG_UI=1`)

GitHub / ローカル Git 収集や日次要約は未実装で、仕様メモは `doc/spec.md` にあります。

## ディレクトリ構成

```text
src/        # ランタイム本体 (TypeScript)
scripts/    # 開発起動・運用起動ヘルパー
hack/       # Slack/CDP 補助スクリプト
doc/        # 設計仕様
tests/      # node --test 用テスト
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
pnpm run typecheck
pnpm run lint
pnpm run format
pnpm run test
pnpm check               # format -> typecheck -> test
```

`pnpm run serve` は `dist/backend/index.js` を実行するため、事前に `pnpm run build:backend` が必要です。

## 実行時設定

| 変数                                       | 既定値                              | 用途                                                                    |
| ------------------------------------------ | ----------------------------------- | ----------------------------------------------------------------------- |
| `CDP_HOST`                                 | `127.0.0.1`                         | CDP 接続先ホスト                                                        |
| `CDP_PORT`                                 | `9222`                              | CDP 接続先ポート                                                        |
| `CDP_ENDPOINT_FILE`                        | `.adjutant/cdp-endpoint.json`       | 接続先上書き JSON (`host`, `port`)                                      |
| `DATA_DIR`                                 | `./data`                            | JSONL 保存ルート                                                        |
| `ADJUTANT_TZ`                              | `Asia/Tokyo`                        | 正規化イベントのタイムゾーン                                            |
| `ADJUTANT_DEBUG`                           | -                                   | Slack アダプタ詳細ログ (`slack:verbose` など)                           |
| `ADJUTANT_DISABLE_DOM_CAPTURE`             | `0`                                 | リアクション時 DOM キャプチャ無効化                                     |
| `ADJUTANT_DEBUG_UI`                        | `0`                                 | Debug UI (`http://127.0.0.1:8787`) を有効化                             |
| `ADJUTANT_DEBUG_UI_PORT`                   | `8787`                              | Debug UI ポート                                                         |
| `ADJUTANT_CDP_EVENT_LOG`                   | `0`                                 | CDP 生イベントを JSONL へ保存                                           |
| `ADJUTANT_CDP_EVENT_LOG_PATH`              | `<dataDir>/_debug/cdp-events.jsonl` | CDP 生イベントの出力先                                                  |
| `ADJUTANT_CDP_EVENT_LOG_MAX_PARAM_CHARS`   | `0`                                 | params を文字列化して上限超過時に切り詰め (`0` は無制限)                |
| `ADJUTANT_RAW_FETCH_LOG`                   | `0`                                 | `raw_fetch` デバッグイベントを JSONL へ保存（内部 fetch hook も有効化） |
| `ADJUTANT_RAW_FETCH_LOG_PATH`              | `<dataDir>/_debug/raw-fetch.jsonl`  | `raw_fetch` イベントの出力先                                            |
| `ADJUTANT_RAW_FETCH_LOG_MAX_PAYLOAD_CHARS` | `0`                                 | payload を文字列化して上限超過時に切り詰め (`0` は無制限)               |

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
