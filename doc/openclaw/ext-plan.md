# ext-plan v2

## 1. 目的

本ドキュメントは、以下2点を **OpenClaw 実装に寄せて** 要件化するための拡張計画。

1. Slack収集プロセス (`pnpm start`) と AIエージェントプロセス (`pnpm run assistant`) の統合
2. SlackイベントからAIへの通知パスに、OpenClaw準拠のメッセージキュー設計を導入

既存の「ハートビート補正（Slow Path）」は維持しつつ、まずは Fast Path（受信イベントの即時処理）を整備する。

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

- 現在の `vendor/openclaw` スナップショットには outbound の write-ahead delivery queue 実装は存在しない。
- `vendor/openclaw/src/infra/outbound/deliver.ts` は直接配送ロジックで、WAL/再起動リカバリを内包しない。
- よって今回の「OpenClaw準拠」は **Slack受信〜AI通知のインプロセスキュー設計** を意味し、配送WALの複製は対象外とする。

## 3. 要求仕様（ブラッシュアップ版）

### 3.1 単一プロセス統合

- `assistant` 起動時に以下を同一プロセスで起動する。
- Slack CDP接続とイベント正規化（現 `src/index.ts` 相当）
- JSONL永続化（現行維持）
- AI APIサーバー + Web UI（現 `src/assistant/main.ts`）
- プロセス間ファイルポーリング前提をやめ、メモリ経由でイベント通知できる構成へ移行する。
- ただし JSONL 保存は監査・再処理のため継続する。

### 3.2 Slack -> AI 通知パイプライン（Fast Path）

新設コンポーネント（仮）: `src/assistant/slack-notification-pipeline.ts`  
内部責務は OpenClaw 準拠で分離する。

- `trigger-filter`:
- 実行可否判定と、`run/system/drop` へのルーティング判定を担当

- `inbound-debounce-buffer`:
- トリガー対象メッセージのバッファリングとテキスト結合を担当

- `notification-queue`:
- 実行要求（run request）のセッション別有界FIFOを担当

- `system-event-queue`:
- 反応系イベントのセッション別有界FIFOを担当（既存 `system-event-queue.ts`）

#### 3.2.1 処理順序（固定）

1. `NormalizedEvent` を分類（post/reaction/notification）
2. `accountId` と self-message 判定を解決
3. `trigger-filter` で `RouteDecision` を生成（`drop` は排他的、`run/system` は独立フラグで併用可）
4. `run` 対象のみ `inbound-debounce-buffer` へ投入
5. デバウンス flush 結果を `notification-queue` へ1エントリ投入
6. `notification-queue` を drain して `ChatHandler.acceptMessage()` へ変換
7. `system` 対象は `system-event-queue` へ投入
8. `drop` 対象（自己送信）はキュー投入せず破棄

#### 3.2.2 デバウンスと cap/drop の関係（明示）

- cap/drop 判定は **デバウンス flush 後** に実施する。
- flush された結合メッセージは **1キューエントリ** として扱う。
- つまり「デバウンス窓内の複数投稿」は、実行要求としては1件で計数する。

#### 3.2.3 トリガー判定（暫定既定）

- 初期版では `post | reaction | notification` をすべて実行トリガー対象とする。
- ただし bot自身/自己送信イベントは実行トリガー対象外とする（ループ防止）。
- self-message は `run/system` のいずれにも投入せず完全無視する。
- 初期版では event 種別による追加抑制フィルタは導入しない。
- ただし無尽蔵化を防ぐため、`cap=20` / `debounce` / lane concurrency / queue wait 警告ログを必須ガードレールとして適用する。
- 将来フェーズで DM/mention の厳格な絞り込みを再導入できるよう、`trigger-filter` の差し替え可能性を維持する。

#### 3.2.4 `kind=post` の inbound/outbound 識別（確定）

- `kind=post` は Slack 受信イベント（message / app_mention など）に限定する。
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

| event kind                   | 条件                 | run | system-event | 備考                                        |
| ---------------------------- | -------------------- | --- | ------------ | ------------------------------------------- |
| `post`                       | 受信由来 かつ 非self | yes | no           | message は本文（デバウンスで結合）          |
| `reaction`                   | 非self               | yes | yes          | run は軽量トリガー文、詳細は system event   |
| `notification`               | 非self               | yes | yes          | run は軽量トリガー文、詳細は system event   |
| `post/reaction/notification` | self                 | no  | no           | 完全無視（ループ防止）                      |
| `post`                       | self判定不可         | no  | no           | fail-safe で drop（run禁止）                |
| `reaction/notification`      | self判定不可         | no  | yes          | fail-safe で system-only（warn ログを残す） |

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

### 3.3 実行レーン統合

- 既存 `src/assistant/command-queue.ts` を OpenClaw準拠へ拡張する。
- laneごとの `maxConcurrent` 対応
- queue wait 警告ログ
- lane clear API（interrupt系制御のため）
- `session:*` lane と `main` lane を分離し、順序保証を維持する。
- **本フェーズでは followup queue（collect/interrupt）を実装しない。**
- AC-6 は「lane 直列化による順序保証」で満たす（followup queue は将来フェーズ）。

### 3.4 system event 注入ポリシー

- **継続する（OpenClaw準拠）**。
- 実装方針:
- `ChatHandler` は system event を次ターン prompt に注入
- 注入後に drain して再注入を防ぐ
- `MAX_EVENTS` と重複抑止は `system-event-queue.ts` で担保

### 3.5 履歴APIとモデル送信文脈の乖離方針

- `/api/chat/history` は当面 transcript 生読み（UI用途）を維持する。
- モデル送信 prompt は system event や実行時コンテキストが乗るため、完全一致は要求しない。
- ドキュメントに「UI表示履歴 != 実際にモデルへ送った最終prompt」を明記する。
- 将来的に必要なら `prompt preview` 用APIを別設計で追加する（本フェーズ非対象）。

### 3.6 Slow Path（ハートビート）継続

- 既存 heartbeat runner は維持。
- Fast Pathで拾い漏らしたケースを Slow Path で補正する二層構成を維持。
- `HEARTBEAT.md` / `AGENTS.md` 運用も継続。
- OpenClaw用語の「Cron + wakeups」は、adjutant では当面 `setInterval` 実装で等価実現する（置換は本フェーズ外）。
- 本フェーズの heartbeat 責務は「判定のみ」とし、送信・memory 更新は担わない。

### 3.7 Slow Path 詳細要件（ext2-plan 取り込み）

- ルーター層の判定漏れ（False Negative）補正を目的に、OpenClawネイティブ方式の巡回を維持する。
- 起動トリガーは「Gateway Cron + wakeups」相当の周期起動（adjutant では `setInterval`）で実施する。
- 起動時プロンプトは `HEARTBEAT.md` と `AGENTS.md` の運用指示を前提に構成し、直近イベントの確認タスクを明示する。
- 巡回時は `session-logs` 相当の手段（`jq` / `rg`）でセッション JSONL を直接検索し、未対応事案を抽出できること。
- 未対応事案を検知した場合は、まず「要対応フラグ/通知要否」の判定結果を返し、送信・記憶更新の実行は本フェーズ外とする。
- 逆に対応不要時は不要通知を避け、静音完了（既存 heartbeat の挙動）を維持する。

### 3.8 単一プロセス化の障害分離

- CDP 接続障害は API サーバー / Web UI へ伝播させない。
- CDP 再接続中も Slow Path（heartbeat）は継続実行する。
- graceful shutdown 順序は `CDP停止 -> 通知キューflush -> API停止` とする。

## 4. インターフェース契約（草案）

### 4.1 Fast Path 入力インターフェース

```ts
type SlackNotificationInput = {
  event: NormalizedEvent;
  accountId: string;
};

type SlackNotificationPipeline = {
  enqueue(input: SlackNotificationInput): void;
  flushSession(sessionKey: string): Promise<void>;
  clearSession(sessionKey: string): number;
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

sessionKey マッピング規則（OpenClaw準拠）:

- `D*` -> `slack:{channelId}`
- `G*` -> `slack:group:{channelId}`（初期版は group/mpim を同一扱い）
- `C*` -> `slack:channel:{channelId}`
- thread reply -> `baseSessionKey:thread:{threadTs}`（親キー保持）

accountId 解決順:

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

1. Given `assistant` を起動したとき、When Slack CDPが利用可能、Then 収集とAPI/UIが単一プロセスで同時起動する。
2. Given 同一スレッドで短時間に複数メッセージが来たとき、When デバウンス窓内、Then AI実行要求は1回に束ねられ、本文は結合される。
3. Given 受信由来の `post | reaction | notification` が到着したとき、When trigger-filter を通す、Then RouteDecision（run/system/drop）に従って処理される。
4. Given `reaction` イベントが連続したとき、When 同一contextKeyが連続、Then system event は重複注入されない。
5. Given notification queue が cap を超えたとき、When dropPolicy=`summarize`、Then summary system event が1件注入され処理継続する。
6. Given run中に同一sessionへの追加イベントが来たとき、When session lane がbusy、Then順序を壊さず後続に直列実行される。
7. Given CDP 接続が切断したとき、When 再接続待機中、Then API/UI は稼働継続し heartbeat は継続する。
8. Given UI履歴APIを呼んだとき、When system event が未反映でも、Then transcriptベース結果を返し、仕様上の乖離が明示される。
9. Given 定期ハートビートが発火したとき、When 直近ログに未対応事案がない、Then ユーザー通知せず静音で終了する。
10. Given 定期ハートビートが発火したとき、When 直近ログに未対応事案がある、Then 要対応判定を記録して終了し、message送信と memory 更新は行わない。
11. Given self 判定IDが未解決の account で `post` が到着したとき、When trigger-filter を通す、Then fail-safe で drop され run は起動しない。
12. Given system event が同一 contextKey で連続到着したとき、When dedupe を適用する、Then 後続イベントは注入されない。
13. Given デバウンス結果が `maxDispatchChars` を超えるとき、When dispatch を生成する、Then `messageTruncated=true` と `originalCharCount` / `dispatchedCharCount` を付与して run を継続する。
14. Given self 判定IDが未解決の account で `reaction` または `notification` が到着したとき、When trigger-filter を通す、Then fail-safe で run を起動せず system-only で処理する。

## 6. 実装タスク（次フェーズ）

### Phase 1 設計固定

- [ ] `src/index.ts` と `src/assistant/main.ts` の統合起動設計を確定
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
- [x] heartbeat責務境界（通知判定のみ / 送信・memory更新まで）を確定

### Phase 2 キュー基盤

- [ ] `trigger-filter` / `inbound-debounce-buffer` / `notification-queue` の分離実装
- [ ] `notification-queue` 実装（有界キュー + summarize）
- [ ] `command-queue` 拡張（lane concurrency / clear）
- [ ] system event 連携（enqueue/drainの接続）
- [ ] `trigger-filter` / `inbound-debounce-buffer` のユニットテスト追加
- [ ] `notification-queue` / `system-event-queue` のユニットテスト追加
- [ ] `command-queue` lane制御のユニットテスト追加

### Phase 3 統合

- [ ] SlackAdapter 出力を JSONL + Fast Path へ二重配送
- [ ] ChatHandler への dispatch 変換経路を実装（idempotencyKey生成含む）
- [ ] 統合起動コマンド整理（README/起動手順更新）

### Phase 4 検証

- [ ] queue overflow / dedupe / debounce テスト追加
- [ ] session lane 順序保証テスト追加
- [ ] heartbeat 巡回（要対応判定なし/あり）の E2E 観点テスト追加
- [ ] `pnpm check` 通過

## 7. 懸念事項と決定事項

### 決定済み

- `ChatHandler` の system event 注入は継続（OpenClaw準拠）。
- `/api/chat/history` の transcript生読みは当面維持（OpenClawと同様の許容）。
- heartbeat責務は「判定のみ」（送信・memory更新は本フェーズ外）。
- Fast Path の実行トリガーは初期版で全イベント（`post|reaction|notification`）に適用。
- コスト方針は「必要コストは許容、ただし無尽蔵化は避ける」とし、初期版は cap/debounce/concurrency/log で制御する。
- デバウンス窓内で event kind 混在を許容する（初期版）。
- `kind=post` は受信イベント専用（outbound は別 kind 扱い / Fast Path 対象外）。
- accountId 取得方式は初期版で `ADJUTANT_SLACK_ACCOUNT_ID` -> `"default"` に固定。
- queue cap 既定値は 20。

### 未確定

- notification queue の永続化要否（現時点はインメモリ前提）。

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
