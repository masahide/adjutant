# ext-plan v2

## 1. 目的

本ドキュメントは、以下2点を **OpenClaw 実装（plugin + startAccount モデル）に寄せて** 要件化するための拡張計画。

1. 収集プロセス (`pnpm start`) と AIエージェントプロセス (`pnpm run assistant`) を、チャネルプラグイン駆動の単一ランタイムへ統合
2. チャネルイベント（初期は Slack）からAIへの通知パスに、OpenClaw準拠のルーター/キュー設計を導入

既存の「ハートビート補正（Slow Path）」は維持しつつ、まずは Fast Path（受信イベントの即時処理）を整備する。初期対応チャネルは Slack とし、仕様は他チャネルへ拡張可能な形で定義する。

### 1.1 進捗同期メモ（2026-02-18）

- モジュール実装済み（単体/統合テストあり）:
- `src/openclaw/channel-manager.ts`
- `src/openclaw/plugin-registry.ts`
- `src/openclaw/channel-notification-pipeline.ts`
- `src/openclaw/dual-write-coordinator.ts`
- `src/openclaw/heartbeat-scanner.ts`
- 起動配線実装済み:
- `src/assistant/main.ts` で `ChannelManager.startChannels()` を実行
- `src/openclaw/slack-channel-plugin.ts` を追加し、`startAccount()` から `ChannelNotificationPipeline` へ本番接続
- `src/assistant/main.ts` で timeline/session 二重追記と `pending-session-backfill` 連携を有効化
- `pnpm run assistant` 単体で 収集 + AI/API/UI を同時起動可能（`pnpm start` は検証用途として残置）

## 2. vendor/openclaw 調査サマリ

### 2.1 受信イベントの入口とデバウンス

- Slack受信は `vendor/openclaw/src/slack/monitor/events/*.ts` でイベント種別ごとにハンドリングされる。
- message/app_mention は `createSlackMessageHandler()` で `createInboundDebouncer()` を通る。
- デバウンスキーは「account + channel/thread + sender」単位で構築される。
- コマンド・添付などはデバウンス対象外で即時flushされる。
- 参照:
- `vendor/openclaw/src/slack/monitor/message-handler.ts`
- `vendor/openclaw/src/auto-reply/inbound-debounce.ts`

### 2.2 SlackイベントからAIコンテキストへの通知

- message/reaction/pin/member/channel などの副次イベントは `enqueueSystemEvent()` でセッション単位キューへ投入される。
- system event キューはインメモリ（永続化なし）で、`MAX_EVENTS = 20`、連続同文の重複を抑止する。
- エージェント実行前に `prependSystemEvents()` が drain し、今回ターンのプロンプト先頭へ注入する。
- 参照:
- `vendor/openclaw/src/infra/system-events.ts`
- `vendor/openclaw/src/auto-reply/reply/session-updates.ts`
- `vendor/openclaw/src/slack/monitor/events/messages.ts`
- `vendor/openclaw/src/slack/monitor/events/reactions.ts`
- `vendor/openclaw/src/slack/monitor/events/pins.ts`

### 2.3 実行キュー

- コマンド実行は lane queue で直列化される。
- `main` lane と `session:*` lane を使い分け、同時実行数 (`maxConcurrent`) を lane ごとに制御できる。
- 実行中メッセージの追従は followup queue（`steer/followup/collect/interrupt`）で吸収する。
- followup queue は `cap` と `dropPolicy(old/new/summarize)` を持つ有界キュー。
- 参照:
- `vendor/openclaw/src/process/command-queue.ts`
- `vendor/openclaw/src/auto-reply/reply/queue/*.ts`
- `vendor/openclaw/src/auto-reply/reply/agent-runner.ts`

### 2.4 セッション解決

- Slackイベントは channel type（im/mpim/channel/group）と thread 情報から sessionKey を解決する。
- thread reply は `resolveThreadSessionKeys()` で親子キーを管理する。
- 参照:
- `vendor/openclaw/src/slack/monitor/context.ts`
- `vendor/openclaw/src/slack/monitor/message-handler/prepare.ts`

### 2.5 UI履歴表示とモデル送信コンテキスト

- OpenClawのセッションプレビュー系は transcript を直接読む方式。
- 一方、モデル送信時には system event 等が追加されるため、UI表示と完全一致は必須要件になっていない。
- 参照:
- `vendor/openclaw/src/gateway/server-methods/sessions.ts`
- `vendor/openclaw/src/gateway/session-utils.fs.ts`

### 2.6 重要な差分確認（誤認防止）

- 現在の `vendor/openclaw` スナップショットには outbound の write-ahead delivery queue 実装が存在する。
- `vendor/openclaw/src/infra/outbound/deliver.ts` は送信前に `enqueueDelivery()` で永続化し、成功後は `ackDelivery()`、失敗時は `failDelivery()` を呼ぶ。
- `vendor/openclaw/src/infra/outbound/delivery-queue.ts` には pending キューの読み出しと `recoverPendingDeliveries()` があり、起動時リカバリを提供する。
- `vendor/openclaw/src/gateway/server.impl.ts` では gateway 起動時に `recoverPendingDeliveries()` を呼び出し、未配送分の再送を試行する。
- ただし今回の「OpenClaw準拠」で本計画が主対象とするのは **チャネル受信〜AI通知のインプロセスキュー設計（Fast/Slow Path）** であり、outbound 配送WALの追実装は本フェーズ対象外とする。

### 2.7 チャネルプラグイン起動方式（startAccount）

- OpenClaw では gateway 起動時に plugin registry を読み込み、各チャネル plugin を `registerChannel()` で登録する。
- 受信監視の起動はチャネル plugin の `gateway.startAccount(ctx)` が担う。`ctx` には `accountId / runtime / abortSignal / setStatus` が渡される。
- `ChannelManager.startChannels()` がチャネル/アカウント単位で `startAccount()` を呼び、停止時は `stopAccount()` と abort を使ってライフサイクルを管理する。
- 実例として Slack/Telegram/Discord/Line などが同じ契約で `monitor*Provider()` を起動している。
- 参照:
- `vendor/openclaw/src/channels/plugins/types.adapters.ts`
- `vendor/openclaw/src/gateway/server-channels.ts`
- `vendor/openclaw/src/plugins/registry.ts`
- `vendor/openclaw/extensions/slack/src/channel.ts`

## 3. 要求仕様（ブラッシュアップ版）

### 3.1 チャネル連携とルーター層（Fast Path）

- `assistant` 起動時に以下を同一プロセスで起動する。
- channel plugin registry（extensions 相当）のロード
- `ChannelManager`（channel/account 単位の `startAccount/stopAccount` 管理）
- JSONL永続化（現行維持）
- AI APIサーバー + Web UI（現 `src/assistant/main.ts`）
- 初期チャネルは Slack plugin とし、既存 `src/index.ts` の起動処理は `startAccount(ctx)` 契約へ移行する。
- 新規チャネル追加は plugin 追加で行い、Router/Queue本体にチャネル固有分岐を持ち込まない。
- 統合起動アーキテクチャ方針は `ChannelPlugin + startAccount + ChannelManager + GatewayRuntime` で固定する。
- ルーター層は受信イベントごとに `run | pending | drop` を判定し、`system` 注入可否を独立フラグで付与する。
- `run` 判定時は `session.lock` を取得してメインエージェントを起動し、セッション JSONL の直近履歴を読み込んだうえで応答する。
- その際、直前まで `pending` としてスルーされていた未対応メッセージ群（連続 `user` ロール）もまとめてコンテキストへ含める。
- エージェントのシステムプロンプトには「未回答の質問/未完了タスクが残っている場合は、今回の緊急対応とあわせて一括回収すること」を明示する。
- プロセス間ファイルポーリング前提をやめ、メモリ経由でイベント通知できる構成へ移行する。
- ただし JSONL 保存は監査・再処理のため継続する。

### 3.2 Channel -> AI 通知パイプライン（Fast Path）

新設コンポーネント（仮）: `src/openclaw/channel-notification-pipeline.ts`  
内部責務は OpenClaw 準拠で分離する。

- `trigger-filter`:
- 実行可否判定と、`run/system/pending/drop` へのルーティング判定を担当

- `inbound-debounce-buffer`:
- トリガー対象メッセージのバッファリングとテキスト結合を担当

- `notification-queue`:
- 実行要求（run request）のセッション別有界FIFOを担当

- `system-event-queue`:
- 反応系イベントのセッション別有界FIFOを担当（既存 `system-event-queue.ts`）

#### 3.2.0 取り込み契約（OpenClaw startAccount 寄せ）

- 各チャネル plugin は `startAccount(ctx)` を実装し、監視中に受信したイベントを `emit(input)`（`channelId/accountId/event`）で通知パイプラインへ渡す。
- `startAccount()` は `abortSignal` で停止可能であること（永続ループを持つ実装を許容）。
- `ChannelManager` は account 単位に `startAccount/stopAccount` を呼び出し、`running/lastError/lastInboundAt` の状態を保持する。
- Fast Path は `channelId/accountId` を入力メタとして受け取り、ルーティング判定はチャネル共通ロジックで実施する（初期版の event kind は `post/reaction/notification`）。

#### 3.2.1 処理順序（固定）

1. `ChannelManager` 経由で `ChannelNotificationInput`（`channelId/accountId/event`）を受け取る
2. `NormalizedEvent` を分類（post/reaction/notification）
3. `accountId` と self-message 判定を解決
4. `trigger-filter` で `RouteDecision` を生成（`drop` は排他的、`run/system` は独立フラグで併用可、`run` と `pending` は排他）
5. `run` 対象のみ `inbound-debounce-buffer` へ投入し、flush 時に `notification-queue` へ1エントリ投入
6. `pending` 対象は即時起動せず、JSONL 上の履歴として保持（次回 `run` または heartbeat の `post` 条件一致時に回収）
7. `notification-queue` を drain して `ChatHandler.acceptMessage()` へ変換
8. `system` 対象は `system-event-queue` へ投入
9. `drop` 対象（自己送信）はキュー投入せず破棄

#### 3.2.2 デバウンスと cap/drop の関係（明示）

- cap/drop 判定は **デバウンス flush 後** に実施する。
- flush された結合メッセージは **1キューエントリ** として扱う。
- つまり「デバウンス窓内の複数投稿」は、実行要求としては1件で計数する。

#### 3.2.3 トリガー判定（暫定既定）

- 初期版では `post | reaction | notification` をすべてルーター判定対象とする。
- ルーターは各イベントを `run`（即時実行）または `pending`（保留）へ振り分ける。
- `pending` は未対応履歴として JSONL に残し、次回 `run` 時に直近の連続 `user` ブロックとしてまとめて回収する。
- ただし bot自身/自己送信イベントは実行トリガー対象外とする（ループ防止）。
- self-message は `run/system` のいずれにも投入せず完全無視する。
- 初期版では event 種別による追加抑制フィルタは導入しない。
- ただし無尽蔵化を防ぐため、`cap=20` / `debounce` / lane concurrency / queue wait 警告ログを必須ガードレールとして適用する。
- 将来フェーズで DM/mention の厳格な絞り込みを再導入できるよう、`trigger-filter` の差し替え可能性を維持する。

#### 3.2.4 `kind=post` の inbound/outbound 識別（Phase 1: Slack）

- `kind=post` はチャネル受信イベントに限定する（Phase 1 は Slack の message / app_mention）。
- `chat.postMessage` など outbound 送信由来データは `kind=post` として扱わない。
- outbound 系を正規化する場合は別 kind（例: `outbound_post`）へ分離し、Fast Path 実行トリガー対象外とする。

#### 3.2.5 summarize drop policy（明示）

- `dropPolicy=summarize` は LLM 要約を使わない。
- ドロップされたエントリから `count + 種別 + 先頭N件の短縮行` をテンプレート合成し、`system event` へ1件注入する。
- 例:
- `[Queue overflow] Dropped 3 messages (post:2, reaction:1). Summary: ...`

#### 3.2.6 queue key（不足情報時フォールバック）

- 基本キーは `accountId + sessionKey + senderId + threadKey`。
- `threadKey` が無い場合は channel レベルキーへフォールバック。
- `senderId` が無い場合は `"unknown-sender"` を使用。
- `accountId` は pipeline 前段で必須解決し、queue key 側で補完しない（取得戦略は §4.2）。

#### 3.2.7 イベント種別ルーティング表（初期版）

| event kind                   | 条件                 | run        | pending    | system-event | 備考                                                |
| ---------------------------- | -------------------- | ---------- | ---------- | ------------ | --------------------------------------------------- |
| `post`                       | 受信由来 かつ 非self | router判定 | router判定 | no           | run/pending は排他。run時は本文をデバウンスで結合。 |
| `reaction`                   | 非self               | router判定 | router判定 | yes          | run は軽量トリガー文、詳細は system event。         |
| `notification`               | 非self               | router判定 | router判定 | yes          | run は軽量トリガー文、詳細は system event。         |
| `post/reaction/notification` | self                 | no         | no         | no           | 完全無視（ループ防止）。                            |
| `post`                       | self判定不可         | no         | no         | no           | fail-safe で drop（run禁止）。                      |
| `reaction/notification`      | self判定不可         | no         | no         | yes          | fail-safe で run禁止。system-only + warn ログ。     |

- `reaction/notification` が `pending` になった場合、これら単独で heartbeat 自律起動は行わない（静音 skip）。
- `reaction/notification` の pending は、次に `post` を契機として Fast Path または heartbeat が起動した際に、補助コンテキストとして巻き込んで回収する。

#### 3.2.8 run message 生成規則（reaction/notification）

- `ChatHandler.acceptMessage()` へ渡す `message` は常に非空文字列にする。
- `post`: 既存本文を使用（デバウンス結合後テキスト）。
- `reaction`: 軽量トリガー文（詳細は system event 側）。
- 例: `[Slack trigger] New reaction events were observed in this session.`
- `notification`: 軽量トリガー文（詳細は system event 側）。
- 例: `[Slack trigger] New notification events were observed in this session.`
- `reaction/notification` の複数件デバウンス時は改行結合し、1 run にまとめる。

#### 3.2.9 run + system 同時ルーティング時の重複規約

- `reaction/notification` は run と system の両方へ流す（OpenClaw 寄せ）。
- 同一情報の二重注入を減らすため、run 側は軽量トリガー文のみを送る。
- 具体的なイベント詳細（actor/emoji/title/message_ts 等）は system event 側にのみ保持する。

#### 3.2.10 contextKey 生成規則（重複抑止）

- `post`: `slack:message:{channel_id}:{message_ts}`
- `reaction`: `slack:reaction:{channel_id}:{message_ts}:{emoji}:{action}:{actor_id_or_actor}`
- `reaction` の actor 要素は `actor_id` を優先し、欠落時のみ `actor` を使う。
- `notification`: `slack:notification:{channel_id_or_unknown}:{notification_type}:{event_ts_or_uid}`
- system event の dedupe は `contextKey` 完全一致で判定する。

#### 3.2.11 dispatch サイズ上限

- `ChatDispatchRequest.message` は `maxDispatchChars`（既定 4000 文字）を上限とする。
- 上限超過時は「先頭保持 + 末尾保持 + truncated 行」を付与して切り詰める。
- truncation 情報は `ChatDispatchRequest` の構造化フィールドで保持する（`messageTruncated`, `originalCharCount`, `dispatchedCharCount`）。
- `message` 内の定型行は可読性向上の補助であり、機械判定契約は構造化フィールドを正とする。
- `eventUids` は `maxEventUidsPerDispatch`（既定 50）を上限とする。
- `idempotencyKey` は切り詰め前の全 UID 集合で計算し、重複実行防止の精度を維持する。

#### 3.2.12 即時対応の実行とペンディング分の一括回収（変更）

- ルーターが `run`（要対応）を返した場合、`session.lock` を取得してメインエージェントを起動する。
- エージェントはセッション JSONL の直近履歴をコンテキストとして読み込み、`pending` として保留されていた直前の未対応メッセージ群も含めて処理する。
- システムプロンプトに「未回答の質問や未完了タスクが残っている場合は今回ターンでまとめて回収すること」を含め、緊急対応と同時に取りこぼしを解消する。
- 一括対応が完了したら assistant レコードを追記し、統合タイムライン側の対応境界を更新する。

### 3.3 ハートビート巡回と補正（Slow Path）

- 定期レビュータスクとして Gateway の Cron / wakeups 相当を使い、一定間隔（例: 15分ごと）で heartbeat を起動する（adjutant では `setInterval` で等価実現）。
- 個別メッセージ単位の「対応済みフラグ」を DB 管理しない。代わりに、全セッションのイベントを集約した統合タイムライン（1ファイル: `memory/timeline.jsonl`）を状態判定ソースとして扱う。
- heartbeat 判定では **統合タイムライン（1ファイル）のみ** を使用し、セッション JSONL 末尾しおりは使わない。
- 判定ロジック:
- `memory/timeline.jsonl` を末尾から逆走査する。
- 逆走査中に最初に見つかった `role="assistant"` または `role="tool"` または `recordType="action"` の行を「最新の対応境界」とし、その時点で走査を打ち切る。
- 未対応判定の対象区間は「末尾（現在）から最新の対応境界まで」とする（対応境界が無い場合はファイル先頭まで）。
- 対象区間に `recordType="event" && role="user" && kind="post"` かつ `now - ts >= heartbeatStaleMs` を満たす行が 1 件以上ある場合のみ「未対応の pending が放置されている」と見なす。
- 対象区間に上記 `post` が存在しない場合は既対応と見なして静音で終了する。
- `reaction/notification` のみで `post` が存在しない場合は未対応判定せず静音で終了する。
- 上記で未対応と判定された場合でも、対象 stale `post` の `uid` が `pending-session-backfill` に存在する間は文脈欠落を避けるため起動を見送り、次周期で再評価する。
- 上記で未対応と判定された場合のみ、`session.lock` を取得してメインエージェントを自律起動する。
- エージェントは直近の未対応メッセージ群（連続 `user` ロール）を読み込み、「プロアクティブに対応すべき事案が隠れていないか」を再評価する。
- 要対応事案が見つかった場合は「先ほどの件ですが…」のように時間差を踏まえた文脈で Slack へ遅延対応を実行する。
- 応答完了後に assistant/action レコードを統合タイムラインへ追記するため、次回 heartbeat では自然にスキップされる。
- `HEARTBEAT.md` / `AGENTS.md` の運用は継続し、heartbeat でも「未回答回収」を優先タスクとして明示する。

### 3.4 実行レーン統合

- 既存 `src/assistant/command-queue.ts` を OpenClaw準拠へ拡張する。
- laneごとの `maxConcurrent` 対応
- queue wait 警告ログ
- lane clear API（interrupt系制御のため）
- `session:*` lane と `main` lane を分離し、順序保証を維持する。
- **本フェーズでは followup queue（collect/interrupt）を実装しない。**
- AC-6 は「lane 直列化による順序保証」で満たす（followup queue は将来フェーズ）。

### 3.5 system event 注入ポリシー

- **継続する（OpenClaw準拠）**。
- 実装方針:
- `ChatHandler` は system event を次ターン prompt に注入
- 注入後に drain して再注入を防ぐ
- `MAX_EVENTS` と重複抑止は `system-event-queue.ts` で担保

### 3.6 履歴APIとモデル送信文脈の乖離方針

- `/api/chat/history` は当面 transcript 生読み（UI用途）を維持する。
- モデル送信 prompt は system event や実行時コンテキストが乗るため、完全一致は要求しない。
- ドキュメントに「UI表示履歴 != 実際にモデルへ送った最終prompt」を明記する。
- 将来的に必要なら `prompt preview` 用APIを別設計で追加する（本フェーズ非対象）。

### 3.7 単一プロセス化の障害分離

- CDP 接続障害は API サーバー / Web UI へ伝播させない。
- CDP 再接続中も Slow Path（heartbeat）は継続実行する。
- graceful shutdown 順序は `CDP停止 -> 通知キューflush -> API停止` とする。

### 3.11 MEMORY 権限分離

- spoke セッション（channel/group/DM）では `MEMORY.md` / `memory/*.md` をロードしない。
- `MEMORY.md` / `memory/*.md` のロードは main セッションのみ許可する。
- `runAgent` 実行時に `memoryScope` を評価し、spoke では memory 解決処理を常に skip する。

## 4. インターフェース契約（草案）

### 4.1 Fast Path 入力インターフェース（チャネル共通）

```ts
type ChannelNotificationInput = {
  event: NormalizedEvent;
  accountId: string;
  channelId: string; // slack | telegram | discord | ...
};

type ChannelNotificationPipeline = {
  enqueue(input: ChannelNotificationInput): void;
  flushSession(sessionKey: string): Promise<void>;
  clearSession(sessionKey: string): number;
};

type ChannelGatewayContext = {
  accountId: string;
  runtime: RuntimeEnv;
  abortSignal: AbortSignal;
  emit: (input: ChannelNotificationInput) => Promise<void>;
  getStatus: () => ChannelAccountSnapshot;
  setStatus: (next: ChannelAccountSnapshot) => void;
};

type ChannelIngestionPlugin = {
  id: string;
  startAccount: (ctx: ChannelGatewayContext) => Promise<unknown>;
  stopAccount?: (ctx: ChannelGatewayContext) => Promise<void>;
};
```

### 4.2 accountId / sessionKey 解決契約

```ts
type ResolveAccountIdInput = {
  event: NormalizedEvent;
  configuredDefaultAccountId?: string;
};

type ResolveSessionKeyInput = {
  accountId: string;
  channelId?: string;
  channelType?: "im" | "mpim" | "channel" | "group";
  threadTs?: string;
  senderId?: string;
};

type ResolveSessionKeyResult = {
  baseSessionKey: string;
  sessionKey: string;
  parentSessionKey?: string;
  chatType: "direct" | "group" | "channel";
};
```

sessionKey マッピング規則（Phase 1: Slack plugin）:

- `D*` -> `slack:{channelId}`
- `G*` -> `slack:group:{channelId}`（初期版は group/mpim を同一扱い）
- `C*` -> `slack:channel:{channelId}`
- thread reply -> `baseSessionKey:thread:{threadTs}`（親キー保持）

補足:

- 他チャネル（Telegram/Discord 等）は plugin 側の resolver で `channelId`/thread 規則を定義し、同じ `sessionKey` 契約へ正規化して渡す。

accountId 解決順（Phase 1: Slack plugin）:

1. `ADJUTANT_SLACK_ACCOUNT_ID`
2. `"default"`

補足:

- `accountId` は「どの Slack ワークスペース/接続に属するイベントか」を識別するID。
- 単一ワークスペース運用では `"default"` 固定でも動作可能。
- 複数ワークスペース運用時は `accountId` を分離しないと、セッション・デバウンス・レート制御が混線する。
- 将来 multi-account が必要になった場合に `event.meta.account_id` 拡張を検討する（本フェーズ外）。

self-message 判定ID 解決順:

1. `selfUserIdByAccount[accountId]`（起動時に解決）
2. `ADJUTANT_SLACK_SELF_USER_ID`（単一運用向けフォールバック）
3. 未解決時は fail-safe:

- `post` は drop（run/system ともに投入しない）
- `reaction/notification` は run 禁止 + system-only
- warn ログと health 警告を出す

### 4.3 Queue設定

```ts
type NotificationQueueConfig = {
  cap: number; // default 20
  debounceMs: number; // default 1000
  dropPolicy: "summarize" | "old" | "new"; // default summarize
  maxDispatchChars: number; // default 4000
  maxEventUidsPerDispatch: number; // default 50
};
```

### 4.4 Fast Path 出力インターフェース（ChatHandler変換）

```ts
type ChatDispatchRequest = {
  message: string; // debounce 後の結合テキスト
  sessionKey: string;
  idempotencyKey: string; // event uid 群と sessionKey から決定的に生成
  eventUids: string[];
  uidOverflowCount?: number;
  messageTruncated?: boolean;
  originalCharCount?: number;
  dispatchedCharCount?: number;
  messageIds?: string[];
  accountId: string;
};
```

idempotencyKey 生成規則（初期版）:

1. flush 対象イベントの `uid` を収集
2. `uid` を辞書順ソートして順序依存を除去
3. `base = sessionKey + "\n" + sortedUids.join("\n")`
4. `idempotencyKey = "sha256:" + sha256(base).hex`

### 4.5 エラー契約

- 通知キュー内の個別イベント失敗でプロセス全体を落とさない。
- 失敗イベントは warn ログ + summary system event 化し、次イベント処理を継続する。
- JSONL永続化失敗時は retry を実施し、規定回数超過後の動作を設定値で制御する。
- `ingest.onWriteError = "continue" | "pause-fast-path" | "stop-process"`（既定値は Phase 1 で確定）。

## 5. 受け入れ条件（Given/When/Then）

1. Given `assistant` を起動したとき、When Slack plugin が有効かつ CDP が利用可能、Then plugin registry / ChannelManager / 収集 / API / UI が単一プロセスで同時起動し、Slack `startAccount()` が開始される。
2. Given 同一スレッドで短時間に複数メッセージが来たとき、When デバウンス窓内、Then AI実行要求は1回に束ねられ、本文は結合される。
3. Given 受信由来の `post | reaction | notification` が到着したとき、When trigger-filter を通す、Then RouteDecision（run/pending/system/drop）に従って処理される。
4. Given `reaction` イベントが連続したとき、When 同一contextKeyが連続、Then system event は重複注入されない。
5. Given notification queue が cap を超えたとき、When dropPolicy=`summarize`、Then summary system event が1件注入され処理継続する。
6. Given run中に同一sessionへの追加イベントが来たとき、When session lane がbusy、Then順序を壊さず後続に直列実行される。
7. Given CDP 接続が切断したとき、When 再接続待機中、Then API/UI は稼働継続し heartbeat は継続する。
8. Given UI履歴APIを呼んだとき、When system event が未反映でも、Then transcriptベース結果を返し、仕様上の乖離が明示される。
9. Given 定期ハートビートが発火したとき、When `memory/timeline.jsonl` を後ろから逆走査して最新の対応境界（`role=assistant | role=tool | recordType=action`）を見つけ、末尾からその境界までの区間に stale な `recordType=event && role=user && kind=post` が存在しない、Then 既対応と見なして静音で終了する。
10. Given 定期ハートビートが発火したとき、When `memory/timeline.jsonl` を後ろから逆走査して最新の対応境界（`role=assistant | role=tool | recordType=action`）を見つけ、末尾からその境界までの区間に stale な `recordType=event && role=user && kind=post` が存在し、かつ該当 `uid` が `pending-session-backfill` に存在しない、Then メインエージェントを起動して未対応メッセージ群を再評価し、必要時は時間文脈を添えて Slack へ遅延対応する。
11. Given self 判定IDが未解決の account で `post` が到着したとき、When trigger-filter を通す、Then fail-safe で drop され run は起動しない。
12. Given system event が同一 contextKey で連続到着したとき、When dedupe を適用する、Then 後続イベントは注入されない。
13. Given デバウンス結果が `maxDispatchChars` を超えるとき、When dispatch を生成する、Then `messageTruncated=true` と `originalCharCount` / `dispatchedCharCount` を付与して run を継続する。
14. Given self 判定IDが未解決の account で `reaction` または `notification` が到着したとき、When trigger-filter を通す、Then fail-safe で run を起動せず system-only で処理する。
15. Given 新規チャネル plugin が `startAccount()` で `ChannelNotificationInput` を emit するとき、When plugin を registry に登録する、Then Fast Path 本体のルーティング/キュー実装を変更せず処理連携できる。

## 6. 実装タスク（次フェーズ）

### Phase 1 設計固定

- [x] `GatewayRuntime`（plugin registry + ChannelManager + assistant runtime）の統合起動**方針**を確定
- [x] `ChannelIngestionPlugin` 契約（`startAccount/stopAccount/emit/status`）の**要求仕様**を確定
- [x] Slack 起動経路を `startAccount(ctx)` へ移行する**方針**を確定
- [ ] sessionKey解決ルール（channel/thread/account）を確定
- [x] accountId取得方式（初期版: `ADJUTANT_SLACK_ACCOUNT_ID` -> `"default"`）を確定
- [x] メンション/トリガー判定ルール（初期版: 全イベント、self-message除外）を確定
- [x] `kind=post` inbound/outbound 識別ルール（受信のみ post）を確定
- [x] `contextKey` 生成規則（post/reaction/notification）を確定
- [x] self 判定未解決時の fail-safe ルールを確定
- [x] truncation 情報の API 契約（構造化フィールド）を確定
- [ ] `NormalizedEvent -> ChatHandler.acceptMessage` 変換仕様を確定
- [x] 通知キュー設定値（cap/debounce/drop）を確定
- [ ] `HEARTBEAT.md` / `AGENTS.md` のテンプレート配置方針を確定
- [x] heartbeat責務境界（統合タイムライン逆走査判定 + 条件一致時のみ自律応答）を確定

### Phase 2 キュー基盤

- [ ] `ChannelManager` 実装（`startChannels/startChannel/stopChannel` + account別状態管理）
- [ ] `trigger-filter` / `inbound-debounce-buffer` / `notification-queue` の分離実装
- [ ] `notification-queue` 実装（有界キュー + summarize）
- [ ] `command-queue` 拡張（lane concurrency / clear）
- [ ] system event 連携（enqueue/drainの接続）
- [ ] plugin registry 実装（channel plugin 登録・起動順制御）
- [ ] `trigger-filter` / `inbound-debounce-buffer` のユニットテスト追加
- [ ] `notification-queue` / `system-event-queue` のユニットテスト追加
- [ ] `command-queue` lane制御のユニットテスト追加

### Phase 3 統合

- [ ] Slack plugin `startAccount()` 出力を JSONL + Fast Path へ二重配送
- [ ] ChatHandler への dispatch 変換経路を実装（idempotencyKey生成含む）
- [ ] 2チャネル目（例: Telegram）を plugin 追加だけで接続できることを検証
- [ ] 統合起動コマンド整理（README/起動手順更新）

### Phase 4 検証

- [ ] queue overflow / dedupe / debounce テスト追加
- [ ] session lane 順序保証テスト追加
- [x] heartbeat 巡回（統合タイムライン逆走査 + 最新の対応境界までの区間判定で skip / stale post 有りかつ `pending-session-backfill` 未滞留時のみ自律応答起動）の E2E 観点テスト追加
- [x] `pnpm check` 通過

## 7. 懸念事項と決定事項

### 決定済み

- `ChatHandler` の system event 注入は継続（OpenClaw準拠）。
- `/api/chat/history` の transcript生読みは当面維持（OpenClawと同様の許容）。
- 統合起動設計の基準アーキテクチャは `ChannelPlugin + startAccount + ChannelManager + GatewayRuntime` で固定する。
- 取り込み拡張の基本単位は `ChannelIngestionPlugin` とし、`startAccount()` 契約でチャネルを増やす。
- heartbeat責務は「統合タイムライン（1ファイル）逆走査判定 + 条件一致時のみ自律応答」とし、`pending-session-backfill` 滞留中は起動見送りとする（常時起動はしない）。
- `reaction/notification` pending は単独 heartbeat では起動せず、次回 `post` 起点 run で補助コンテキストとして回収する。
- Fast Path の対象イベントは初期版で全イベント（`post|reaction|notification`）とし、各イベントを `run/pending` へルーター判定する。
- コスト方針は「必要コストは許容、ただし無尽蔵化は避ける」とし、初期版は cap/debounce/concurrency/log で制御する。
- デバウンス窓内で event kind 混在を許容する（初期版）。
- `kind=post` は受信イベント専用（outbound は別 kind 扱い / Fast Path 対象外）。
- accountId 取得方式は初期版で `ADJUTANT_SLACK_ACCOUNT_ID` -> `"default"` に固定。
- queue cap 既定値は 20。

### 未確定

- notification queue の永続化要否（現時点はインメモリ前提）。
- heartbeat の「放置判定」閾値（既定値）と、セッション別の可変設定可否。
- `pending` 連続 `user` ブロックを一括回収する際の最大コンテキスト長（トークン/文字）と切り詰め方針。
- plugin 起動失敗時の隔離方針（単一チャネル fail-open / fail-stop の既定）。

---

## 参考（調査対象ファイル）

- `vendor/openclaw/src/slack/monitor/message-handler.ts`
- `vendor/openclaw/src/auto-reply/inbound-debounce.ts`
- `vendor/openclaw/src/infra/system-events.ts`
- `vendor/openclaw/src/auto-reply/reply/session-updates.ts`
- `vendor/openclaw/src/process/command-queue.ts`
- `vendor/openclaw/src/auto-reply/reply/queue/*.ts`
- `vendor/openclaw/src/slack/monitor/context.ts`
- `vendor/openclaw/src/gateway/server-methods/sessions.ts`
- `vendor/openclaw/src/gateway/session-utils.fs.ts`
- `vendor/openclaw/src/infra/outbound/deliver.ts`
- `vendor/openclaw/src/infra/outbound/delivery-queue.ts`
- `vendor/openclaw/src/gateway/server.impl.ts`
- `vendor/openclaw/src/gateway/server-channels.ts`
- `vendor/openclaw/src/channels/plugins/types.adapters.ts`
- `vendor/openclaw/src/plugins/registry.ts`
- `vendor/openclaw/extensions/slack/src/channel.ts`
