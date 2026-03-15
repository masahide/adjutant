# データモデル仕様

## 1. 目的

この文書は、Adjutant が扱う主要データモデルと識別子方針を定義する。

## 2. スコープ

### 含むもの

- 共通イベントスキーマ
- Slack detail モデル
- UID 方針
- 派生ルールの基本契約

### 含まないもの

- 保存場所や追記手順
  - 将来 `storage.md`
- API request / response schema
  - 将来 `http-api.md`

## 3. 共通イベントモデル

型定義は `src/core/events.ts` に従う。

```ts
{
  schema: "adjutant.event.v1.1";
  uid: string;
  source: "slack" | "github" | "git-local";
  kind: string;
  action?: string;
  actor?: string;
  subject?: string;
  ts: string;
  logged_at?: string;
  meta?: Record<string, unknown>;
  detail?: { slack: SlackDetail } | { github: Record<string, unknown> } | { git_local: Record<string, unknown> };
}
```

## 4. Slack Detail モデル

`SlackDetail` は union だが、現実装では主に以下キーを利用する。

- post
  - `channel_id`, `channel_name`, `message_ts`, `text`, `blocks`, `thread_ts`
- reaction
  - `channel_id`, `channel_name`, `message_ts`, `emoji`, `user`, `message_text`
- notification
  - `channel_id`, `channel_name`, `notification_type`, `title`, `message_text`, `user`, `event_ts`

vNext では notification について、collector 調整により以下の optional key を追加収集する前提とする。

- `team_id?`
- `thread_ts?`
- `message_ts?`
- `permalink?`
- `mention_target_user_id?`
- `is_direct_mention?`

## 5. UID 方針

- post UID
- reaction UID
- notification UID
- 同一プロセス内去重

具体的には次のとおり。

- post
  - `slack:{channel_id}@{message_ts}`
- reaction
  - `slack:{channel_id}@{message_ts}:{emoji}:{action}:{actorId}`
- notification
  - `slack:{channel_id}@{event_ts or now}:{notification_type}:{actorId}`

`SlackAdapter` は同一 `uid` をメモリ上で去重し、同一プロセス内での重複書き込みを防ぐ。

## 6. 派生ルール

- `message_ts` は raw field が無い場合、`ts` または `entry.item.message.ts` から派生してよい
- `permalink` は raw field を必須とせず、`workspaceHost + channel_id + message_ts` から派生してよい
- `mention_target_user_id` は raw field を必須とせず、Slack blocks の `user` node または本文中の `<@USER_ID>` から抽出してよい
- `is_direct_mention` は raw field が無い場合、抽出した mention target と self user id から派生判定してよい

## 7. 実装対応

- 共通イベントモデルは `src/core/events.ts` に対応する
- Slack detail は collector / normalizer 側の生成契約に対応する
- UID 方針は `SlackAdapter` の去重単位と保存イベント識別子の前提になる

## 8. 既知の制約

- 現実装の `detail.slack` には `type` フィールドを付与していない
- イベント種別は `kind` で判別する
- 本文フィールド契約は `post -> detail.slack.text`、`reaction|notification -> detail.slack.message_text` を正とする
- 詳細フィールドの一部は raw payload ではなく派生値でよい

## 9. 関連文書

- [概要](/Users/USER/masahide/git/adjutant/doc/spec/overview.md)
- [機能一覧](/Users/USER/masahide/git/adjutant/doc/spec/feature-catalog.md)
- [詳細仕様インデックス](/Users/USER/masahide/git/adjutant/doc/spec/detail-index.md)
