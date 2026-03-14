# Raw Log Notification Validation

目的:

- Slack notification 派生ロジックの回帰確認を行う。
- 新しい workspace 追加時に、`teamId / messageTs / permalink / mentionTargetUserId / isDirectMention` の解決が期待どおり動くかを診断する。
- `workspaceHost` 自動学習や `threadTs` の観測可否を確認する。

補足:

- 現行 `src` 側の collector 本線は `raw-fetch.jsonl` を直接出力しないため、検証は `pnpm rawlog:capture` を使う。
- このキャプチャは `raw_ws` と `raw_fetch` の両方を `slack-debug.jsonl` に保存する。
- 現状の実装ではデバッグしやすさを優先し、`ADJUTANT_SANDBOX_MODE` の既定値は一時的に `off` になっている。
- Phase 1 の基本調査は完了している。現在の主目的は「未実装項目の調査」ではなく、「派生実装の回帰確認」と「新規 workspace の診断」である。

## 既に確定していること

- `teamId` は raw payload から取得できる。
- `messageTs` は `message_ts` raw field 必須ではなく、`ts` 系 field から派生する。
- `mentionTargetUserId` は raw field 直取得ではなく、`text` / `blocks` から派生する。
- `isDirectMention` は mention target と self user id から派生判定する。
- `permalink` は `channelId + messageTs + workspaceHost` から生成する。
- `workspaceHost` は自動学習を優先し、足りない場合は設定値 `ADJUTANT_SLACK_WORKSPACE_HOSTS` を使う。

## 事前準備

1. Slack Desktop が CDP で接続可能な状態にする
2. Slack Desktop の対象ワークスペースが開かれていることを確認する

補助スクリプト:

```bash
pnpm rawlog:prepare
```

このコマンドは以下を出力する:

- 解決済み `dataDir`
- raw log の保存先
- 推奨 `export` 群
- 起動コマンド

## 推奨環境変数

```bash
export ADJUTANT_RAW_LOG_PATH=/path/to/slack-debug.jsonl
export ADJUTANT_RAW_FETCH_LOG_MAX_PAYLOAD_CHARS=20000
```

必要なら `ADJUTANT_RAW_LOG_PATH` を上書きする。

補足:

- raw log の採取自体に Docker sandbox は不要
- `pnpm start` は使わず、`pnpm rawlog:capture` を使う
- Docker sandbox を有効化した状態で確認したい場合だけ `ADJUTANT_SANDBOX_MODE=non-main|all` を明示する

## 実行手順

1. raw log capture を起動する

```bash
pnpm rawlog:capture
```

2. Slack 上で自分宛メンション通知を 1 回以上発生させる
3. capture を動かしたまま、別ターミナルで raw log を解析する

```bash
pnpm rawlog:analyze
```

必要なら対象ファイルを明示する。

```bash
node --import tsx scripts/analyze-raw-fetch-log.ts --file /path/to/slack-debug.jsonl
```

解析結果を保存したい場合:

```bash
node --import tsx scripts/analyze-raw-fetch-log.ts --output ./tmp/raw-fetch-report.json
```

## 人間が確認するポイント

通知候補レコードと解析結果について、次を確認する。

- `team_id` または `team`
- `event_ts`
- `ts`
- `thread_ts`
- `workspaceHost` が解決されているか
- `permalink` が期待する host で生成されているか
- `mentionTargetUserId` が抽出できているか
- `isDirectMention` が `true` になっているか

見方:

- `fieldPresence` は該当 key を持つ record 数
- `sampleCandidates` は notification 系と思われる先頭サンプル
- `matchedReasons` は notification 候補として拾った理由

## 判定ルール

- `teamId / messageTs / mentionTargetUserId / isDirectMention` が期待どおり出ている:
  - 通知派生ロジックは正常
- `permalink` が `app.slack.com` fallback のまま:
  - `workspaceHost` 自動学習が間に合っていない可能性がある
  - 必要なら `ADJUTANT_SLACK_WORKSPACE_HOSTS` を設定する
- `thread_ts` が見えない:
  - v1 では optional のまま許容する
  - anchor 不足時は `needs_review` に倒す
- `mentionTargetUserId` または `isDirectMention` が期待どおり出ない:
  - 対象 payload の `text` / `blocks` を sampleCandidates から確認する
  - self user id 設定を見直す

## 期待成果物

- raw log の実ファイル
- `pnpm rawlog:analyze` の JSON 出力
- 新しい workspace または新しい通知パターンで、派生結果が期待どおりかどうかの記録

## 補足

- repo 内に採取済みの `slack-debug.jsonl` は含めない
- raw log には機密情報が含まれ得るため、共有前に必ずマスクする
