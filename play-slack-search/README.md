# play-slack-search

Slack を `playwright-cli` 経由で検索し、検索結果またはチャンネル一覧・ユーザー一覧を JSON として取得する小さな CLI です。

内部動作の説明は [doc/how-it-works.md](./doc/how-it-works.md) を参照してください。

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
PLAY_SLACK_SEARCH_PROFILE=~/.playwright-cli/slack
```

## 主なコマンド

```bash
pnpm slack-search --query 'from:me'
pnpm slack-search --list-channels --limit 10
pnpm slack-search --list-users --limit 10
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

チャンネル一覧をファイルへ保存する例です。

```bash
pnpm slack-search --list-channels --limit 50 --output ./tmp/channels.json
```

ユーザー一覧をファイルへ保存する例です。

```bash
pnpm slack-search --list-users --limit 100 --output ./tmp/users.json
```

## ディレクトリ構成

- `scripts/slack-search.ts`: CLI のエントリポイント
- `scripts/slack-search/`: オプション解析、セッション管理、実行本体
- `scripts/slack-search/browser/`: `playwright-cli run-code` に渡すブラウザ内ロジック
- `doc/how-it-works.md`: 内部動作と取得方法の説明
- `tests/`: 単体テスト
