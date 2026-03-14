# 260310-s01: Slack Notification Driven Flow 実装計画

## 0. Core Principles

本章の原則は、この計画の全セクションと今後の全実装タスクに共通して適用する。特定箇所だけに限定して適用するものではない。

- Prototype First: 本計画全体で `vendor/openclaw` 寄せの単純な session / transcript モデルを優先し、durable queue / replay / duplicate 吸収は v1 から外す。既存の journal / idempotency 前提とは非互換になり得るため、破壊点は plan と spec に明記する。
- SOLID: 本計画全体で責務分離を優先し、収集、通知分類、AI 実行調停、Slack 検索 adapter、heartbeat、UI view を分離して設計する。単一モジュールへ複数責務を寄せない。
- KISS: 本計画全体で複雑さを増やさず、v1 は「明らかに自分宛の Slack 通知を `slack-activity` で処理し、必要なら `play-slack-search` で文脈取得する」最小構成に絞る。
- YAGNI: 本計画全体で現時点に不要な機能を入れず、Slack 自動送信、thread ごとの Slack session 分離、durable decision store、heartbeat の独自分類器は採用しない。
- DRY: 本計画全体で重複した契約や実装を作らず、heartbeat prompt 契約、busy 時の `skip + retry`、`HEARTBEAT_OK` の扱いは `vendor/openclaw` と同じ mental model を採用し、Slack 読み取りは `play-slack-search` へ集約する。

## 1. 概要と目的 Overview and Purpose

- What
  - Slack からは「明らかに自分宛の通知」だけを即時 AI 起動トリガーとして扱う。
  - 通知だけでは文脈が不足するため、AI は必要に応じて `play-slack-search` を呼び、thread / message / search のいずれかで周辺文脈を取得する。
  - `self post` と `self reaction` は自分の行動ログとして記録するが、AI 即時起動トリガーにはしない。`self reaction` は反応先本文を reaction 時点のスナップショットとして保持する。
  - heartbeat は `main` セッション上の full agent turn として定期実行し、`HEARTBEAT.md` を読み、必要な対応がなければ `HEARTBEAT_OK` で終了する。
  - Slack 通知一覧は `ActivityFeed` として表示するが、これは durable queue や SoT ではなく UI 向けの lightweight unread view とする。
- Why
  - file journal ベースの replay / idempotency / completion 管理を本格運用するには、rotation・partitioning・整合制御の実装コストが高い。
  - 現段階では、厳密な復旧性よりも OpenClaw 寄せの単純な session/transcript モデルの方が目的に合う。
  - Slack 全量収集や広い proactive pipeline はスコープに対して重すぎる。
- How
  - 通知取得は既存 `collector-slack` の CDP 収集を使うが、処理対象は self-directed notification に限定する。
  - Slack 読み取りは `customTools` 経由の `play-slack-search` だけに絞る。
  - AI の結果は `no_action | draft_reply | needs_review` に正規化するが、独立した decision store には保存せず transcript や UI 表示に残す。
  - v1 では Slack 送信口は持たず、返信が必要な場合は draft reply の生成までに留める。
  - heartbeat は `vendor/openclaw` と同じく main セッションで走る full turn とし、busy 時は割り込まず skip して後で再試行する。

## 2. 仕様と受け入れ条件 Specification and Acceptance Criteria

### 2.1 スコープ Scope

- 今回やること
  - self-directed Slack notification を即時 AI 起動トリガーとして扱う契約を定義する
  - `self post` / `self reaction` を record-only の self activity として扱う方針を定義する
  - Slack 通知専用の `ActivityFeed` を UI view として定義する
  - self-directed allowlist を定義する
    - `strong`: DM、明示メンション
    - `medium`: 自分が参加した thread への返信、キーワード通知
    - `weak`: リアクション通知、一般 activity、分類不能通知
  - Slack 通知起点 run の既定 session を `slack-activity` に固定し、`threadTs` / `messageTs` は Slack 参照の anchor として扱う規約を明文化する
  - `play-slack-search` を現行 `customTools` に `spawn adapter` で組み込む
  - AI の結果を `no_action | draft_reply | needs_review(replyText?)` に正規化する
  - `vendor/openclaw` 相当の heartbeat を main セッション上の full agent turn として有効化する
  - 仕様・図・テストを OpenClaw 寄せ前提に整理する
- 成果物
  - 実装: `src/collector-slack/*`, `src/control-plane/*`, `src/assistant/*`
  - View: `ActivityFeed`（Slack 通知専用の unread view）
  - テスト: unit / integration / contract
  - ドキュメント: `doc/spec.md` 必要差分、今回の計画書
- 制約
  - v1 は Slack source のみ対象
  - 即時 AI 起動入力は「明らかに自分宛の通知」と「手動 user message」のみ
  - `self post` / `self reaction` は記録のみで即時 AI 起動には使わない
  - anchor が解決できない通知は自動送信しない
  - durable replay、idempotency、Slack 送信、exactly-once delivery は v1 の責務にしない
  - heartbeat は main セッション上で動かし、`vendor/openclaw` 相当のシンプルな full turn に寄せる
  - ActivityFeed は専用 AI セッションではなく、Slack 通知専用の read-only view とする

### 2.2 非スコープ Non Scope

- Slack 全メッセージ・reaction・channel post の常時収集
- 他人同士の post / reaction の常時記録
- `inbox` / `idempotency` / `decision history` / `deliver completion` / `heartbeat result` を durable SoT として持つ設計
- restart 後の replay
- command / ingest duplicate/conflict 吸収
- Slack reply delivery
- exact-once reply delivery
- attention window / batch classifier / pending flusher を使った広い proactive routing
- heartbeat 専用の閾値ベース分類器や score-based review
- session 間の live state 参照
- shared knowledge の高度な統合設計
- 専用の review UI
- Slack Activity 専用の会話セッション
- GitHub / Jira など他 source の取り込み

### 2.3 ユースケース Use Cases

- 正常系1: DM 通知を受けて thread を取得し、返信案を生成する
  - AI が `play-slack-search(mode=thread)` で thread を読み、`draft_reply` を返す
- 正常系2: mention 通知を受けるが返信不要と判断する
  - AI が thread を確認し、`no_action` を返す
- 正常系3: 自分が参加した thread への返信やキーワード通知は即時 run せず、Slack 通知一覧で確認できる
- 正常系4: anchor 不足または文脈不足の通知を受ける
  - 自動返信せず `needs_review(replyText?)` に倒す
- 正常系5: Slack 通知起点の run は `slack-activity` セッションに集約される
  - thread ごとの session 分離は行わず、必要な文脈は毎回 `play-slack-search` で取得する
- 正常系6: 自分が reaction した投稿を後から追跡できる
  - self reaction は record-only の行動ログとして反応先本文つきで保持されるが、即時 AI 起動はしない
- 正常系7: heartbeat が `HEARTBEAT.md` をコンテキストに full agent turn を実行する
- 正常系8: heartbeat 実行時に main セッションが busy である
  - heartbeat は割り込まず `skip + 後再試行` になる
- 正常系9: `HEARTBEAT.md` が存在しない
  - default heartbeat prompt で run は継続する
- 正常系10: `HEARTBEAT.md` が実質空
  - heartbeat run 自体を skip する
- 正常系11: heartbeat が `HEARTBEAT_OK` を返す
  - 追加の表示や送信は発生しない
- 正常系12: user が Slack 通知を新しい順に確認したい
  - notification の全文と AI 判断が 1 つの feed で閲覧できる
- 異常系1: `play-slack-search` が timeout / rate limit / not found になる
  - run は `needs_review` に倒れる
- 異常系2: 同一通知が重複到着する
  - v1 では durable duplicate 吸収は行わず、その場の実行で扱う

### 2.4 受け入れ条件 Acceptance Criteria

1. Given `strong` に分類される Slack 通知が到着する  
   When 通知処理が開始される  
   Then 即時 AI run が `slack-activity` セッションで起動する
2. Given 通知に `messageTs` しかない  
   When `play-slack-search(mode=message)` で親 thread を解決する  
   Then 解決成功時は thread anchor を使って文脈取得し、失敗時は `needs_review` に倒れる
3. Given AI run が通知処理を開始する  
   When 文脈取得が必要になる  
   Then `play-slack-search` は `spawn adapter + customTools` 経由で呼ばれ、`thread/message/search` のいずれかの mode で結果を返す
4. Given AI が通知を評価し `draft_reply` または `needs_review(replyText?)` を返す  
   When run が完了する  
   Then replyText と判断理由が transcript または UI 表示から確認でき、Slack 自動送信は行われない
5. Given `weak` 通知、self post、または self reaction が観測される  
   When collector が受理する  
   Then それらは record-only として保持され、即時 AI run は起動しない
6. Given heartbeat の定期時刻に main セッションが空いている  
   When heartbeat が起動する  
   Then `HEARTBEAT.md` または default prompt を使う full agent turn が main セッション上で実行される
7. Given heartbeat の定期実行中に `main` が busy、`HEARTBEAT.md` が実質空、または結果が `HEARTBEAT_OK` である  
   When heartbeat 実行結果を処理する  
   Then それぞれ `skip + 後再試行`、run skip、UI 既定フィルタの契約で扱われる

### 2.5 既知の制約 Known Limitations

- 通知設定や Slack 側の仕様に依存するため、通知されない重要会話は即時経路では拾えない。
- 通知 snippet は不完全であり、正確な判断には追加の Slack 読み取りが前提となる。
- `messageTs` しかない通知は thread anchor 解決に追加 fetch が必要になる場合がある。
- `needs_review(replyText?)` を返しても、v1 では専用 review UI は持たない。
- heartbeat は main セッションを再利用するため、有意味な heartbeat turn は main 側の履歴に影響する。
- ActivityFeed は durable audit log ではなく、Slack 通知専用の UI view である。
- restart 後の未処理通知 replay や duplicate 吸収は保証しない。

## 3. 前提技術スタック Context and Tech Stack

- Language Framework
  - TypeScript (ESM), Node.js
- Libraries
  - 既存 `@mariozechner/pi-coding-agent`, `tsx`
  - 現行 `customTools` 連携
  - `play-slack-search`
  - 既存 control-plane / ACP / heartbeat 経路
- Style Guide
  - `AGENTS.md` と repository guidelines に従い、TypeScript ESM / Prettier / ESLint / 既存の命名規約を維持する
- Runtime Deployment
  - `src/index.ts` を起点とする単一 control-plane
  - 通知取得は既存 `collector-slack` を利用
  - heartbeat は既存 control-plane の定期実行基盤を利用し、main セッション上の full agent turn として動かす
- Testing
  - Node.js test runner
  - 既存の unit / integration / contract テスト構成を維持

## 4. インターフェース契約 Interface Contracts

### 4.1 公開APIまたは外部I O一覧

- 外部イベント入力
  - 既存 `collector/ingest`
  - 即時 AI 起動対象は `NormalizedEvent(kind=notification)` のうち明らかに自分宛の notification のみ
  - `NormalizedEvent(kind=post|reaction)` の self event は record-only
- Tool I/O
  - `play_slack_search(mode, ...)`
  - 論理機能として `thread`, `message`, `search` を提供する
- heartbeat I/O
  - `HEARTBEAT.md` が存在すればその内容を heartbeat prompt の workspace context として利用する
  - `HEARTBEAT.md` が存在しなければ default heartbeat prompt を利用する
  - heartbeat 応答が `HEARTBEAT_OK` のみ、または同等の短い ACK の場合は無内容として扱う
- HTTP API
  - 既存 `POST /api/commands`
  - 既存 heartbeat run / history API を利用するかは実装時に整理するが、durable history store 前提にはしない
- 設定ファイル
  - `HEARTBEAT.md`
  - heartbeat 関連の既存 env var
- 永続化ストレージ
  - v1 の標準経路では dedicated durable SoT を追加しない
- UI View
  - `ActivityFeed`（Slack 通知専用）
- 外部サービス連携
  - Slack Desktop CDP notification source
  - `play-slack-search`

### 4.2 データモデルとスキーマ

- `SlackNotificationEvent`
  - 位置づけ: notification 処理のための軽量 projection
  - `channelId`
  - `threadTs?`
  - `messageTs?`
  - `actorId?`
  - `title?`
  - `snippet?`
  - `permalink?`
  - `sessionKey` 既定値は `slack-activity`
  - `selfDirectedLevel: "strong" | "medium" | "weak"`
  - `selfDirectedReason: "dm" | "explicit_mention" | "participated_thread_reply" | "keyword_match" | "reaction_notification" | "generic_activity" | "unknown"`
- `SelfActivityEvent`
  - 位置づけ: self event の lightweight activity view
  - `kind: "post" | "reaction"`
  - `channelId`
  - `threadTs?`
  - `messageTs?`
  - `messageText?` reaction 時点のスナップショット
  - `emoji?`
  - `action?`
  - `sessionKey` 既定値は `slack-activity`
- `slack-activity` セッション規約
  - Slack 通知起点 run は thread/channel ごとに session を分離せず、既定で `slack-activity` セッションへ集約する
  - `threadTs` は thread 文脈取得用の最優先 anchor として扱う
  - `messageTs` しかない場合は `play-slack-search(mode=message)` で親 thread を解決し、成功時は文脈取得に使う
  - DM / group / channel の違いは session 分離には使わず、Slack 検索引数の違いとして扱う
  - `messageTs` から anchor 解決失敗した場合は `needs_review` に倒す
- `PlaySlackSearchRequest`
  - `mode: "thread" | "message" | "search"`
  - `channelId?`
  - `threadTs?`
  - `messageTs?`
  - `query?`
  - `limit?`
- `PlaySlackSearchResult`
  - `mode`
  - `items[]`
  - `nextCursor?`
  - `warnings[]`
- `NotificationDecision`
  - `action: "no_action" | "draft_reply" | "needs_review"`
  - `reason`
  - `replyText?`
  - `reviewNotes?`
- `ActivityItem`
  - 位置づけ: AI セッションではない read-only UI view
  - `activityId`
  - `ts`
  - `kind: "notification_received" | "draft_reply" | "needs_review" | "note"`
  - `messageText`
  - `title`
  - `summary?`
  - `sessionKey?`
  - `permalink?`
  - `status?`

### 4.3 エラーと例外 Error Handling

- エラー分類
  - `INVALID_NOTIFICATION`
  - `SLACK_CONTEXT_NOT_FOUND`
  - `PLAY_SLACK_SEARCH_INVALID_ARGS`
  - `SLACK_TOOL_TIMEOUT`
  - `SLACK_RATE_LIMITED`
  - `INVALID_AI_OUTCOME`
- リトライ方針
  - `play-slack-search` は短い retry を許容するが、上限到達時は `needs_review`
  - heartbeat は main セッション busy 時に `skip + 後再試行` とし、ユーザー会話を優先する
- タイムアウト方針
  - `play-slack-search` ごとに timeout を設定する
  - timeout 時は run 全体を落とさず `needs_review` に変換する
- ログ方針と個人情報の扱い
  - `sessionKey`, `decision.action`, `heartbeat run status` を構造化ログ出力する
  - Slack 本文全文や token はログへ出さない

### 4.4 代表的な例 Examples

- 例1: `strong` 通知から draft reply を作る

```json
{
  "notificationType": "mention",
  "channelId": "C123",
  "threadTs": "1741935600.000100",
  "snippet": "@you これ確認できますか？"
}
```

```json
{
  "action": "draft_reply",
  "reason": "依頼内容が明確で返信案を生成できる",
  "replyText": "確認します。必要なら追加情報をください。"
}
```

- 例2: `messageTs` だけの通知を thread 解決する

```json
{
  "mode": "message",
  "channelId": "C123",
  "messageTs": "1741935600.000100"
}
```

```json
{
  "mode": "message",
  "items": [
    {
      "ts": "1741935600.000100",
      "threadTs": "1741935500.000050",
      "text": "@you これ確認できますか？"
    }
  ],
  "warnings": []
}
```

- 例3: heartbeat の no-op 結果

```text
HEARTBEAT_OK
```

```text
UI 既定表示ではフィルタし、slack-activity には表示しない
```

## 5. アーキテクチャと設計図 Architecture and Diagrams

### 5.1 図の選択方針

- OpenClaw 寄せで durable queue を減らすため、図は `notification -> session run -> tool -> draft reply` の単純な流れを表す。
- heartbeat は `main` セッションでの full agent turn として、Slack 通知処理とは別 lane で示す。
- `ActivityFeed` は AI 実行基盤ではなく、Slack 通知専用の UI view であることを明示する。

### 5.2 クラス図 Class Diagram

```mermaid
classDiagram
  class CollectorSlackAdapter {
    +emitNotificationEvent()
    +emitSelfActivityEvent()
  }

  class NotificationRouter {
    +classify(event)
    +resolveSessionKey(event)
  }

  class NotificationRunCoordinator {
    +dispatch(event)
    +normalizeDecision(runResult)
    +publishDraft(decision)
  }

  class OpenClawStyleHeartbeatRunner {
    +runOnce()
    +schedulePeriodic()
    +retryWhenBusy()
  }

  class ActivityFeedBuilder {
    +appendNotification(item)
    +appendDecision(item)
    +listFeed()
  }

  class WorkerSupervisor {
    +request(method, params)
  }

  class PlaySlackSearchSpawnAdapter {
    +execute(mode, args)
  }

  CollectorSlackAdapter --> NotificationRouter
  NotificationRouter --> NotificationRunCoordinator
  NotificationRouter --> ActivityFeedBuilder
  NotificationRunCoordinator --> WorkerSupervisor
  NotificationRunCoordinator --> ActivityFeedBuilder
  WorkerSupervisor --> PlaySlackSearchSpawnAdapter
  OpenClawStyleHeartbeatRunner --> WorkerSupervisor
```

### 5.3 シーケンス図 Sequence Diagram

```mermaid
sequenceDiagram
  participant CDP as collector-slack
  participant Router as NotificationRouter
  participant Worker as WorkerSupervisor
  participant Tool as play-slack-search(spawn)
  participant Heartbeat as OpenClawStyleHeartbeatRunner
  participant Feed as ActivityFeedBuilder

  CDP->>Router: notification
  Router->>Feed: append notification_received
  alt selfDirectedLevel == strong
    Router->>Worker: session/prompt(meta: sessionKey=slack-activity, notification)
    Worker->>Tool: play_slack_search(...)
    Tool-->>Worker: context
    Worker-->>Router: NotificationDecision
    alt action == draft_reply
      Router->>Feed: append draft_reply
    else action == needs_review / no_action
      Router->>Feed: append needs_review/note
    end
  else selfDirectedLevel == medium or weak
    Router-->>Router: no immediate run
  end

  Heartbeat->>Worker: session/prompt(meta: sessionKey=main, isHeartbeat=true)
  alt main session busy
    Worker-->>Heartbeat: skipped(requests-in-flight)
    Heartbeat->>Heartbeat: retry later
  else HEARTBEAT.md missing
    Heartbeat->>Worker: default heartbeat prompt
  else HEARTBEAT.md effectively empty
    Heartbeat-->>Heartbeat: skip run
  else HEARTBEAT_OK
    Worker-->>Heartbeat: ok-token / ok-empty
  else meaningful output
    Worker-->>Heartbeat: sent
  end
```

## 6. テスト戦略 Test Strategy

### 6.1 テストの種類

- Unit
  - notification projection と `slack-activity` セッション固定規約
  - `selfDirectedLevel` / `selfDirectedReason` 判定
  - self post / self reaction が record-only になること
  - self reaction に反応先メッセージ本文が保持されること
  - `ActivityItem` unread view 生成
  - `play-slack-search` spawn adapter の mode 別入力 validation
  - `NotificationDecision` 正規化
  - heartbeat が `HEARTBEAT_OK` / empty / meaningful output を正しく分類できること
  - heartbeat が main busy 時に `skip + 後再試行` になること
  - `HEARTBEAT.md` missing / effectively empty の挙動
- Integration
  - notification から AI run 起動までの縦断
  - self event が記録のみで終わる縦断
  - `customTools` 経由で `play-slack-search` が spawn される縦断
  - `draft_reply` 決定までの縦断
  - heartbeat 定期実行から `skip + retry` / `HEARTBEAT_OK` / meaningful output までの縦断
  - ActivityFeed が notification を新しい順に並べ、全文と AI 判断を表示する縦断
- Contract
  - `SlackNotificationEvent` projection 契約
  - `slack-activity` セッション規約
  - `ActivityItem` unread view 契約
  - `play-slack-search` spawn adapter の I/O contract

### 6.2 カバレッジ対象

- 重要ロジック
  - self-directed notification の判定
  - self event の record-only 分岐
  - self reaction の本文スナップショット保持
  - `messageTs` しかない通知の anchor 解決
  - heartbeat の OpenClaw 互換挙動
- エラー分岐
  - `play-slack-search` timeout
  - rate limit
  - invalid args
  - invalid notification
- 境界条件
  - snippet なし
  - threadTs なし
  - 同一 thread への手動 message 追加
  - `strong / medium / weak` 境界の notification

## 7. 実装タスクリスト Implementation Plan

### Phase 1 設計と準備

- [ ] self-directed notification allowlist を確定する
- [ ] `SlackNotificationEvent` projection 契約と `slack-activity` セッション規約を確定する
- [ ] `SelfActivityEvent` と `ActivityItem` の最小 view 契約を確定する
- [ ] `play-slack-search` の `spawn adapter` 契約を確定する
- [ ] `NotificationDecision=no_action|draft_reply|needs_review(replyText?)` 契約を確定する
- [ ] heartbeat を OpenClaw 互換の `HEARTBEAT.md + HEARTBEAT_OK + skip/retry` 契約に固定する
- [ ] spec から replay / idempotency / durable SoT 前提を落とす差分方針を確定する

### Phase 2 通知処理と activity view の実装

- [ ] Test notification projection と `slack-activity` セッション固定の失敗テストを追加する Red
- [ ] Impl notification projection の最小実装を追加する Green
- [ ] Test self reaction の本文スナップショット保持に関する失敗テストを追加する Red
- [ ] Impl self activity の record-only 保存を追加する Green
- [ ] Test ActivityFeed の notification 表示に関する失敗テストを追加する Red
- [ ] Impl `ActivityItem` view の最小実装を追加する Green
- [ ] Docs ActivityFeed を durable SoT ではなく UI view として更新する

### Phase 3 `play-slack-search` spawn adapter 統合

- [ ] Test `play-slack-search` の `customTools` 登録と `thread/message/search` mode の失敗テストを追加する Red
- [ ] Impl `play-slack-search` spawn adapter を `src/assistant/agent-session-factory.ts` 系へ最小実装する Green
- [ ] Refactor spawn adapter とエラーマッピングを整理する
- [ ] Integration `customTools` 経由で `play-slack-search` が spawn される統合テストを追加する
- [ ] Docs tool I/O と contract boundary を更新する

### Phase 4 通知 run と draft reply の実装

- [ ] Test `NotificationDecision` 正規化と `draft_reply` / `needs_review` の失敗テストを追加する Red
- [ ] Impl AI run 起動と draft reply 生成の最小実装を行う Green
- [ ] Refactor notification run と UI 表示連携を整理する
- [ ] Integration 通知 -> thread 取得 -> decision の統合テストを追加する

### Phase 5 heartbeat の OpenClaw 寄せ実装

- [ ] Test `HEARTBEAT.md` missing / effectively empty / `HEARTBEAT_OK` / meaningful output / busy retry の失敗テストを追加する Red
- [ ] Impl heartbeat を OpenClaw 互換の main session full turn に寄せる Green
- [ ] Refactor heartbeat と UI 表示の責務分離を整理する
- [ ] Integration heartbeat 定期実行の統合テストを追加する

## 8. Definition of Done

### 8.1 機能DoD Functional DoD

- [ ] self-directed `strong` notification で即時 AI run が起動すること
- [ ] `play-slack-search` が `customTools` 経由で利用できること
- [ ] self post / self reaction が record-only として扱われること
- [ ] self reaction が反応先本文スナップショットを保持できること
- [ ] 返信が必要なケースで draft reply が生成できること
- [ ] heartbeat が OpenClaw 互換の `HEARTBEAT.md + HEARTBEAT_OK + skip/retry` 挙動を示すこと
- [ ] ActivityFeed で Slack 通知の unread 一覧が表示できること

### 8.2 品質DoD Quality DoD

- [ ] unit / integration / contract テストが追加されていること
- [ ] `pnpm check` が通ること
- [ ] replay / idempotency / durable SoT 前提の古い記述が plan から除去されていること
- [ ] `doc/spec.md` に反映すべき差分が洗い出されていること

## 9. 懸念事項と未確定事項 Concerns and Questions

- `self post` / `self reaction` の record-only 保存先は既存実装のどこに寄せるかを実装時に最終決定する必要がある。
- `ActivityFeed` は unread view として定義したが、既読管理を v1 で持つかどうかは未確定である。
- `play-slack-search` の `spawn adapter` は外部コマンド障害の影響を受けるため、timeout とエラー表示の UX を実装で詰める必要がある。
- `slack-activity` を単一セッションに集約するため、長期運用では transcript が肥大化する可能性がある。v1 では許容する。
- heartbeat は OpenClaw 寄せで `main` に残るため、有意味な heartbeat turn が main の履歴へ混ざる点はプロトタイプとして許容する。
