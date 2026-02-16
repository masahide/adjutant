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

### 3.2 Slack -> AI 通知キュー（Fast Path）

新設コンポーネント（仮）: `src/assistant/slack-notification-queue.ts`

- 役割:
- 収集済み `NormalizedEvent` を受け取り、デバウンス/重複抑止/有界キュー制御した上で AI 側へ通知する。

- キュー要件:
- セッション単位の有界キュー（default cap: 20）
- drop policy: `summarize`（既定）/`old`/`new`
- 連続重複抑止（contextKey 同一）
- デバウンス（default 1000ms）
- デバウンスキーは OpenClaw 準拠で `account + channel/thread + sender` 相当

- 出力要件:
- `kind=post` は message run 対象として `ChatHandler.acceptMessage()` 相当へ渡す
- `kind=reaction|notification` は `enqueueSystemEvent()` のみ実施
- 必要に応じて `summary event` を system event として注入（overflow時）

- ルーティング要件:
- sessionKey 解決は channel type + thread を考慮する
- 同一 thread のイベントは同一 session lane へ束ねる

### 3.3 実行レーン統合

- 既存 `src/assistant/command-queue.ts` を OpenClaw準拠へ拡張する。
- laneごとの `maxConcurrent` 対応
- queue wait 警告ログ
- lane clear API（interrupt系制御のため）
- `session:*` lane と `main` lane を分離し、順序保証を維持する。

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

## 4. インターフェース契約（草案）

### 4.1 新規イベント通知インターフェース

```ts
type SlackNotificationInput = {
  event: NormalizedEvent;
  accountId?: string;
};

type SlackNotificationQueue = {
  enqueue(input: SlackNotificationInput): void;
  flushSession(sessionKey: string): Promise<void>;
  clearSession(sessionKey: string): number;
};
```

### 4.2 Queue設定

```ts
type SlackNotifyQueueConfig = {
  cap: number; // default 20
  debounceMs: number; // default 1000
  dropPolicy: "summarize" | "old" | "new"; // default summarize
};
```

### 4.3 エラー契約

- 通知キュー内の個別イベント失敗でプロセス全体を落とさない。
- 失敗イベントは warn ログ + summary system event 化し、次イベント処理を継続する。
- JSONL永続化失敗は既存同様 retry の上で error とする（収集は継続可否を設定で切替）。

## 5. 受け入れ条件（Given/When/Then）

1. Given `assistant` を起動したとき、When Slack CDPが利用可能、Then 収集とAPI/UIが単一プロセスで同時起動する。
2. Given 同一スレッドで短時間に複数 `post` が来たとき、When デバウンス窓内、Then AI実行は1回に束ねられ、本文は統合される。
3. Given `reaction` イベントが連続したとき、When 同一contextKeyが連続、Then system event は重複注入されない。
4. Given 通知キューが cap を超えたとき、When dropPolicy=`summarize`、Then summary system event が1件残り処理継続する。
5. Given run中に同一sessionへの追加イベントが来たとき、When session lane がbusy、Then順序を壊さず後続実行へ回される。
6. Given UI履歴APIを呼んだとき、When system event が未反映でも、Then transcriptベース結果を返し、仕様上の乖離が明示される。

## 6. 実装タスク（次フェーズ）

### Phase 1 設計固定

- [ ] `src/index.ts` と `src/assistant/main.ts` の統合起動設計を確定
- [ ] sessionKey解決ルール（channel/thread/account）を確定
- [ ] 通知キュー設定値（cap/debounce/drop）を確定

### Phase 2 キュー基盤

- [ ] `slack-notification-queue` 実装（有界キュー + debounce + summarize）
- [ ] `command-queue` 拡張（lane concurrency / clear）
- [ ] system event 連携（enqueue/drainの接続）

### Phase 3 統合

- [ ] SlackAdapter 出力を JSONL + 通知キューへ二重配送
- [ ] ChatHandler への `post` 通知経路を実装
- [ ] 統合起動コマンド整理（README/起動手順更新）

### Phase 4 検証

- [ ] queue overflow / dedupe / debounce テスト追加
- [ ] session lane 順序保証テスト追加
- [ ] `pnpm check` 通過

## 7. 懸念事項と決定事項

### 決定済み

- `ChatHandler` の system event 注入は継続（OpenClaw準拠）。
- `/api/chat/history` の transcript生読みは当面維持（OpenClawと同様の許容）。

### 未確定

- notification queue の永続化要否（現時点はインメモリ前提）。
- `post` 以外イベントの即時run起動要否（現時点は system event 注入のみ）。
- queue cap の本番既定値（20 or 50 以上）と監視メトリクス閾値。

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
