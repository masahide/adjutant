# ReacLog

Slack や Git/GitHub のアクティビティを収集し、日次ログとして要約するための開発用ツール群です。Chrome DevTools Protocol (CDP) を介して Slack デスクトップアプリからメッセージやリアクションを取得し、JSONL に保存した後、MD サマリを生成するワークフローを提供します。将来的には Git/GitHub ソースも統合することを目指しています。

## 主な機能

- Slack デスクトップ (app.slack.com) への CDP 接続と DOM キャプチャによる本文取得
- 正規化済みイベントの JSONL 保存およびキャッシュ処理 (`src/index.ts`)
- CDP ポートフォワードや Slack 起動を補助するシェルスクリプト群 (`hack/`)
- アーキテクチャ仕様書 (`docs/spec.md`) に基づくログパイプライン構想

## ディレクトリ構成

```
├── src/              # TypeScript エントリポイント
├── docs/             # 仕様・設計ドキュメント
├── apps/browser/     # SvelteKit 製のログビューア
├── hack/             # WSL⇔Windows 連携や CDP 用スクリプト
├── package.json      # スクリプト定義・依存関係
└── AGENTS.md         # コントリビューションガイド
```

## 前提条件

- Node.js 18+（開発は LTS を推奨）
- pnpm 8 以上（`npm install -g pnpm` などで導入）
- Slack デスクトップアプリと Chrome/Edge がローカルで稼働
- CDP が有効な Slack セッション（`CDP_HOST`/`CDP_PORT` を環境変数で指定可能）

## セットアップ

```bash
git clone <this-repo>
cd reaclog
pnpm install
```

## 開発コマンド

```bash
pnpm dev                      # Slack CDP の立ち上げ確認 + backend/browser を並列起動
pnpm start                    # tsx 経由で Slack 収集プロセスを起動
pnpm run serve                # Slack ヘルパー + backend + browser を一括起動（本番想定、-- --open でブラウザを自動表示）
pnpm run build:backend        # dist/backend/index.js を生成
pnpm run build:browser        # ブラウザアプリをビルド (apps/browser/build)
pnpm run build:runtime        # backend と browser のビルドをまとめて実行
pnpm run typecheck            # TypeScript 型チェック（ワークスペース全体）
pnpm run lint                 # ESLint による静的解析
pnpm run format               # Prettier でフォーマット検証
pnpm run test                 # Node 側の test runner (node --test)
pnpm --filter browser dev     # ログビューア (SvelteKit) の開発サーバー
pnpm --filter browser test    # ビューアの Vitest (サーバーロード + E2E 風テスト)
pnpm --filter browser exec tsc --noEmit  # ビューア側 TypeScript 型チェック
pnpm run qa                   # 上記すべて（typecheck/lint/format/test/svelte-kit sync/svelte-check/ブラウザ型検証/Vitest）
```

`pnpm dev` は Slack の CDP 接続（`CDP_HOST`/`CDP_PORT`）を検査し、必要に応じて `hack/launch_slack_cdp.sh` で再起動した後に `pnpm start` とビューア開発サーバーを並列起動します。CDP ポートのオープン待ちは 1 秒間隔で最大 10 回リトライし、`CDP_WAIT_ATTEMPTS` / `CDP_WAIT_DELAY` で試行回数と待機時間を調整できます。ログは `logs/backend-dev.log` / `logs/browser-dev.log` に追記され、コンソールにもタイムスタンプ付きで出力されます。

`pnpm run serve -- --open` を指定すると、フロントエンドが立ち上がったタイミングで既定ブラウザ（macOS: `open`, Windows: `start`, Linux: `xdg-open`）を自動起動します。
Slack が CDP 無効で動作中の場合は終了して再起動するかどうかを必ず確認されます。対話に応じた上で続行してください。

## ログビューア (SvelteKit)

`apps/browser/` には JSONL と Markdown を読み込むログビューアが含まれています。`pnpm --filter browser dev` で開発サーバーを起動し、`http://localhost:5173` から以下を確認できます。

### ログブラウザのサーバー起動手順

```bash
pnpm --filter browser dev
```

上記コマンドで Vite の開発サーバーが立ち上がり、既定では `http://localhost:5173` にアクセスできます。別ホスト/ポートで公開したい場合は `pnpm --filter browser dev -- --host 0.0.0.0 --port 4173` のように Vite の引数を渡してください。

本番相当で確認したい場合はビルド後にプレビューサーバーを利用できます。

```bash
pnpm --filter browser build
pnpm --filter browser preview -- --host 0.0.0.0 --port 4173
```

`REACLOG_DATA_DIR` などの環境変数は通常どおり `pnpm --filter browser dev` の前に指定するか、`.env` に記述して読み込ませます。

- ダッシュボード：最新 7 日分のイベント件数と Slack/GitHub/その他ソース別の内訳
- 日付別ページ：フィルタ付きタイムライン、Markdown サマリ、原文 JSONL へのリンク、リアルタイムストリーム（JSONL 追記は数秒以内に反映）
- テーマ切替：ライト/ダーク/システムの 3 モードを UI から切り替え。ブラウザの `prefers-color-scheme` と同期し、コントラスト AA 以上を維持
- メッセージ表示：Slack の Markdown 記法（`*bold*` や `> quote` など）を HTML として再現し、リアクションは元メッセージのプレビュー付きで表示
- Raw ビュー：日付ごとの JSONL をそのまま表示（デバッグ用）

環境変数 `REACLOG_DATA_DIR` で参照するデータディレクトリを指定できます。

テストは以下の通りです。

- `pnpm run test`：ワークスペース共通の Node テスト（`node --test`）
- `pnpm --filter browser test`：SvelteKit ルート/API の Vitest
- `pnpm --filter browser exec tsc --noEmit`：ブラウザアプリの型チェック
- `pnpm run qa`：上記すべて + `svelte-kit sync` → `svelte-check` を一括で実行

## Slack/CDP セットアップ

`hack/` ディレクトリのスクリプトを利用すると、WSL から Windows で動く Slack へのポートプロキシやブラウザ起動を整備できます。Slack を起動後、`chrome-remote-interface list` などで `app.slack.com` ターゲットが表示されることを確認してください。必要に応じて `CDP_HOST`/`CDP_PORT` を環境変数として指定します。資格情報（トークンやクッキー等）は絶対にリポジトリへコミットせず、共有時も必ずマスクしてください。

DOM 取得は既定で有効です。リアクションが本文付きで記録されない場合は、Slack を操作した直後に対象メッセージが可視範囲にあるか確認してください。リアクション DOM の取り込みは `/api/reactions.*` への自分の POST をトリガーにしており、他メンバーのリアクション通知（WebSocket 経由）では DOM キャプチャは動きません。詳しくは後述のデバッグフラグと手動検証手順を参照してください。

`hack/launch_slack_cdp.sh` は macOS で Slack をリモートデバッグポート付きで起動し、`curl http://localhost:<port>/json/version` が成功するまで再試行します。`CDP_WAIT_ATTEMPTS`（既定 10）と `CDP_WAIT_DELAY`（既定 1 秒）で挙動を調整でき、`pnpm dev` からも同じ環境変数が利用されます。

## Slack ケースのデバッグ

Slack 収集の挙動は環境変数で切り替えられます。

| 変数                          | 例                             | 説明                                                                                                                                                                       |
| ----------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REACLOG_DEBUG`               | `slack:verbose,slack:domprobe` | Slack アダプタの詳細ログ。`slack:verbose` で正規化の詳細、`slack:domprobe` で DOM 評価ログ、`slack:network` / `slack:fetch` / `slack:runtime` で各イベントを個別に有効化。 |
| `REACLOG_DISABLE_DOM_CAPTURE` | `1`                            | DOM 取得を完全に停止（本文は空のまま記録される）。フォールバックは存在しないため調査時のみに使用。                                                                         |
| `REACLOG_TZ`                  | `Asia/Tokyo`                   | タイムゾーン上書き。未指定時は `Asia/Tokyo` を使用。                                                                                                                       |
| `REACLOG_TZ`                  | `Asia/Tokyo`                   | タイムゾーン上書き。未指定時は `Asia/Tokyo`                                                                                                                                |

**起動例**

- 通常運用（最小ログ）
  ```bash
  pnpm start
  ```
- DOM 取得を調査したい場合
  ```bash
  REACLOG_DEBUG=slack:verbose,slack:domprobe pnpm start | tee -a debug_dom.log
  ```
- DOM を無効化してキャッシュのみ確認
  ```bash
  REACLOG_DISABLE_DOM_CAPTURE=1 REACLOG_DEBUG=slack:verbose pnpm start | tee -a debug_fallback.log
  ```

### 手動検証（リアクション DOM キャプチャ）

1. `REACLOG_DEBUG=slack:verbose pnpm start` を実行し、自分でリアクションを 1 件追加する。
   - 直後に `{"ok":true,...}` の DOM ログが表示され、`data/.../events.jsonl` に本文付きで記録されることを確認。
2. 他メンバーのリアクションが Slack に届いた場合でも、新たな DOM ログ（`{"ok":false,...,"reason":"dom-not-found"}` など）が増えないことを確認。WebSocket 経由では DOM キャプチャが発火しないため、想定通りスキップされる。
3. 必要に応じて `REACLOG_DISABLE_DOM_CAPTURE=1` で再実行し、DOM キャプチャ無効化時に本文が空のまま記録されるフォールバックを確認する。

## Slack アダプタのデバッグ

Slack 収集の挙動は環境変数で切り替えられます。

| 変数                          | 例                             | 説明                                                                                                                                                                       |
| ----------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REACLOG_DEBUG`               | `slack:verbose,slack:domprobe` | Slack アダプタの詳細ログ。`slack:verbose` で正規化の詳細、`slack:domprobe` で DOM 評価ログ、`slack:network` / `slack:fetch` / `slack:runtime` で各イベントを個別に有効化。 |
| `REACLOG_DISABLE_DOM_CAPTURE` | `1`                            | DOM 取得を完全に停止（本文は空のまま記録される）。フォールバックは存在しないため調査時のみに使用。                                                                         |
| `REACLOG_TZ`                  | `Asia/Tokyo`                   | タイムゾーン上書き。未指定時は `Asia/Tokyo`。                                                                                                                              |

**起動例**

- 通常運用（最小ログ）
  ```bash
  pnpm start
  ```
- DOM 取得を調査したい場合
  ```bash
  REACLOG_DEBUG=slack:verbose,slack:domprobe pnpm start | tee -a debug_dom.log
  ```
- DOM を無効化してキャッシュのみ確認
  ```bash
  REACLOG_DISABLE_DOM_CAPTURE=1 REACLOG_DEBUG=slack:verbose pnpm start | tee -a debug_fallback.log
  ```

ログには API トークン等が含まれることがあります。共有前には必ず `debug.log` などを削除するか、秘匿情報をマスクしてください。

## 仕様と今後の開発

データモデルや日次要約の詳細は `docs/spec.md` を参照してください。GitHub やローカル Git のアダプタ追加、JSONL 保存、LLM 要約機能はロードマップに含まれています。新しいモジュールやテストを追加する際は `AGENTS.md` に記載のコーディング規約と PR ガイドラインを遵守してください。
