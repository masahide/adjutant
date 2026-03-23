# データモデル仕様

## 1. 目的

この文書は、Adjutant が扱う主要データモデルと識別子方針を定義する。

## 2. スコープ

### 含むもの

- 共通イベントスキーマ
- Slack detail モデル
- assistant permission / guardrail モデル
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

## 6. Assistant Permission / Guardrail モデル

assistant 実行系では、tool 実行前の guardrail と human review のために次のモデルを扱う。

- `PendingPermission`
  - `requestId`
  - `sessionId`
  - `runId?`
  - `toolCallId?`
  - `title`
  - `reason?`
  - `ruleId?`
  - `policyCandidate?`
  - `createdAt`
  - `expiresAt?`
- `PersistedGuardrailPolicy`
  - `policyId`
  - `scope`
    - `session`
    - `workspace`
    - `global`
  - `scopeKey?`
  - `match`
    - `toolName?`
    - `path?`
    - `toolHubMode?`
    - `toolHubProvider?`
    - `toolHubAction?`
    - `bashCommandPrefix?`
  - `effect`
    - `allow`
    - `deny`
  - `createdAt`
  - `createdBy`
- `GuardrailAuditRecord`
  - `ts`
  - `sessionId`
  - `runId?`
  - `toolCallId`
  - `toolName`
  - `decision`
    - `allow`
    - `review`
    - `forbid`
  - `reason`
  - `ruleId?`
  - `policySource`
    - `builtin`
    - `persisted`
    - `default`
    - `llm_advisory`

識別子と意味論:

- `requestId`
  - pending permission の一意識別子であり、UI / SSE / `/api/permissions/resolve` で共通に使う
- `workspaceScopeKey`
  - `workspace` scope policy の照合キーであり、`projectRoot:<abs-path>::workspaceDir:<abs-path>` を使う
- `policyCandidate`
  - `allow_always` / `reject_always` の保存候補であり、tool 種別に応じて path や `tool_hub` action 粒度まで絞る
- permission selection
  - `allow_once`
  - `allow_always`
  - `reject_once`
  - `reject_always`
  - `cancelled`

## 7. 派生ルール

- `message_ts` は raw field が無い場合、`ts` または `entry.item.message.ts` から派生してよい
- `permalink` は raw field を必須とせず、`workspaceHost + channel_id + message_ts` から派生してよい
- `mention_target_user_id` は raw field を必須とせず、Slack blocks の `user` node または本文中の `<@USER_ID>` から抽出してよい
- `is_direct_mention` は raw field が無い場合、抽出した mention target と self user id から派生判定してよい

## 8. 実装対応

- 共通イベントモデルは `src/core/events.ts` に対応する
- Slack detail は collector / normalizer 側の生成契約に対応する
- UID 方針は `SlackAdapter` の去重単位と保存イベント識別子の前提になる
- permission / guardrail モデルは `src/control-plane/acp/permission-registry.ts`, `src/control-plane/contracts/http-api.ts`, `src/guardrails/types.ts` に対応する

## 9. 既知の制約

- 現実装の `detail.slack` には `type` フィールドを付与していない
- イベント種別は `kind` で判別する
- 本文フィールド契約は `post -> detail.slack.text`、`reaction|notification -> detail.slack.message_text` を正とする
- 詳細フィールドの一部は raw payload ではなく派生値でよい
- guardrail の advisory は audit 用の補助情報であり、最終 decision モデルそのものではない

## 10. 関連文書

- [概要](/Users/USER/masahide/git/adjutant/doc/spec/overview.md)
- [機能一覧](/Users/USER/masahide/git/adjutant/doc/spec/feature-catalog.md)
- [詳細仕様インデックス](/Users/USER/masahide/git/adjutant/doc/spec/detail-index.md)
