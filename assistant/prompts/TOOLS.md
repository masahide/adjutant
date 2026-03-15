# TOOLS.md - Local Notes

Skills define how tools work. This file keeps local environment notes.

## Tool Hub

用途:
custom integration を探して使うための総合入口です。専用ツールがありそうなのに direct tool が見当たらないときは、まず `tool_hub` を確認します。

使い方:

- 引数なし: provider 一覧
- `provider` のみ: action 一覧
- `provider + action`: その action の help / schema
- `provider + action + args`: 実行

Tips / 注意事項:

- Slack、memory、今後追加される custom integration は基本的にここから辿ります
- 専用ツール名が分からないときの最初の確認先として使います

## Slack Search

用途:
Slack メッセージ検索と thread/permalink 解決。自分の投稿を取りたいときは `from:me` を使う。

必須パラメータと頻出例:

- `mode=search|thread|message|permalink`
- `query` は `mode=search` で必須
- 例: `from:me`
- 例: `from:@やまさき after:2026-03-03`
- 例: `from:me in:#texチーム`
- 例: `mode=thread, channelId=..., threadTs=...`

Tips / 注意事項:

- Slack UI と同じ検索構文で評価される
- 自分の投稿は `from:me`、自分宛ては `to:me`
- `@表示名` 指定はヒットしないことがある。その場合は `from:me`、`from:<@USER_ID>`、`after:` 付き再検索を試す
- 検索結果ページの文脈取得は `tool_hub(provider=slack, action=search, args=...)` を使う

## Examples

- Camera names and locations
- SSH hosts and aliases
- Device nicknames
- Runtime constraints and caveats

## Why This Exists

Tool definitions can be shared across projects. This file captures workspace-specific facts.
