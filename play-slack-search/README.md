# play-slack-search

Slack を `playwright-cli` 経由で検索し、検索結果またはチャンネル一覧・ユーザー一覧を JSON として取得する小さな CLI です。

内部動作の説明は [doc/how-it-works.md](./doc/how-it-works.md) を参照してください。

## まずこれを見る

用途:
Slack メッセージ検索。自分の投稿だけを取りたいときは `from:me` を使います。

必須パラメータと頻出クエリ例:

- `--query` は検索実行で必須
- `from:me`
- `from:@やまさき after:2026-03-03`
- `from:me in:#texチーム`
- `error from:me after:2026-03-03`

Tips / 注意事項:

- Slack UI と同じ検索構文で検索されます
- 自分の投稿は `from:me`、自分宛ては `to:me`
- `from:@表示名` はヒットしないことがあります。その場合は `from:me` や `from:<@USER_ID>` を試してください
- 0 件なら、まず人だけの条件でヒット確認してから `after:` や `in:` を足すと切り分けやすいです

## セットアップ

```bash
pnpm install
cp .env.example .env
```

`.env` にワークスペース URL などのローカル設定を置きます。`.env` はリポジトリに含まれません。

```dotenv
PLAY_SLACK_SEARCH_WORKSPACE_URL=https://your-workspace.slack.com
# 任意
PLAY_SLACK_SEARCH_SESSION=auto
PLAY_SLACK_SEARCH_PROFILE=~/.adjutant/tools/play-slack-search/profile
```

## 主なコマンド

```bash
pnpm slack-search --query 'from:me'
pnpm slack-search --login
pnpm slack-search --list-channels --limit 10
pnpm slack-search --list-users --limit 10
pnpm slack-search --list-users --hydrate
pnpm format:write
pnpm check
```

`pnpm check` は次を順に実行します。

1. `pnpm format:check`
2. `pnpm typecheck`
3. `pnpm test`

## スクリプト一覧

- `pnpm slack-search`: Slack 検索 CLI を実行します。
- `pnpm format:write`: Prettier でコードを整形します。
- `pnpm format:check`: Prettier の整形差分を検査します。
- `pnpm typecheck`: TypeScript の型チェックを実行します。
- `pnpm test`: `node:test` による単体テストを実行します。
- `pnpm check`: format check, type check, test をまとめて実行します。

## 実行例

検索結果を 1 件だけ取得する例です。

```bash
pnpm slack-search --query 'from:me' --limit 1
```

`.env` を使わずに都度指定する場合は `--workspace-url` を渡してください。

```bash
pnpm slack-search --workspace-url https://your-workspace.slack.com --query 'from:me'
```

ログイン済みセッションを作りたい場合は `--login` を使います。Slack のトップページを persistent profile 付きの visible browser で開いてすぐ戻るので、そのブラウザでログインしてください。セッション情報は profile に保存されます。

```bash
pnpm slack-search --workspace-url https://your-workspace.slack.com --login
```

チャンネル一覧をファイルへ保存する例です。

```bash
pnpm slack-search --list-channels --limit 50 --output ./tmp/channels.json
```

一覧前に Slack クライアント状態の warm-up を試みたい場合は `--hydrate` を付けます。

```bash
pnpm slack-search --list-channels --hydrate --output ./tmp/channels.json
```

ユーザー一覧をファイルへ保存する例です。

```bash
pnpm slack-search --list-users --limit 100 --output ./tmp/users.json
```

新しい session やログイン期限切れの状態では、`--list-users` / `--list-channels` は Slack client state を読めず失敗することがあります。その場合は先に `--login` で対象 workspace にログインしてください。複数 workspace がありうる場合は `--workspace-url` を明示する方が安全です。

## ディレクトリ構成

- `scripts/slack-search.ts`: CLI のエントリポイント
- `scripts/slack-search/`: オプション解析、セッション管理、実行本体
- `scripts/slack-search/browser/`: `playwright-cli run-code` に渡すブラウザ内ロジック
- `doc/how-it-works.md`: 内部動作と取得方法の説明
- `tests/`: 単体テスト
