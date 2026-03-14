# 260310-s01: Slack Notification Driven Flow 実装計画

## 0. Core Principles

本章の原則は、この計画の全セクションと今後の全実装タスクに共通して適用する。特定箇所だけに限定して適用するものではない。

- Prototype First: 本計画全体で `vendor/openclaw` 寄せの単純な session / transcript モデルを優先し、durable queue / replay / duplicate 吸収は v1 から外す。既存の journal / idempotency 前提とは非互換になり得るため、破壊点は plan と spec に明記する。
- SOLID: 本計画全体で責務分離を優先し、収集、通知分類、AI 実行調停、Slack 検索 adapter、heartbeat、UI view を分離して設計する。単一モジュールへ複数責務を寄せない。
- KISS: 本計画全体で複雑さを増やさず、v1 は「自分宛メンション通知を `slack-activity` で処理し、必要なら `play-slack-search` で文脈取得する」最小構成に絞る。
- YAGNI: 本計画全体で現時点に不要な機能を入れず、Slack 自動送信、thread ごとの Slack session 分離、durable decision store、heartbeat の独自分類器は採用しない。
- DRY: 本計画全体で重複した契約や実装を作らず、heartbeat prompt 契約、busy 時の `skip + retry`、`HEARTBEAT_OK` の扱いは `vendor/openclaw` と同じ mental model を採用し、Slack 読み取りは `play-slack-search` へ集約する。

## 1. 概要と目的 Overview and Purpose

- What
  - Slack からは「自分宛メンション通知」だけを即時 AI 起動トリガーとして扱う。
  - 通知だけでは文脈が不足するため、AI は必要に応じて `play-slack-search` を呼び、`thread / message / search / permalink` のいずれかで周辺文脈を取得する。
  - `self post` と `self reaction` は自分の行動ログとして日次ファイルへ記録するが、AI 即時起動トリガーにはしない。`self reaction` は反応先本文を reaction 時点のスナップショットとして保持する。
  - heartbeat は `main` セッション上の full agent turn として定期実行し、`HEARTBEAT.md` を読み、必要な対応がなければ `HEARTBEAT_OK` で終了する。
  - Slack 通知一覧は `ActivityFeed` として表示するが、これは durable queue や SoT ではなく UI 向けの lightweight unread-like view とし、v1 では既読状態を保持しない。
- Why
  - file journal ベースの replay / idempotency / completion 管理を本格運用するには、rotation・partitioning・整合制御の実装コストが高い。
  - 現段階では、厳密な復旧性よりも OpenClaw 寄せの単純な session/transcript モデルの方が目的に合う。
  - Slack 全量収集や広い proactive pipeline はスコープに対して重すぎる。
  - `vendor/openclaw` は session/transcript 中心の runtime と heartbeat full-turn 契約を採る実装であり、本計画はその単純な実行モデルに寄せる。
- How
  - 通知取得は既存 `collector-slack` の CDP 収集を使うが、処理対象は自分宛メンション通知に限定する。notification 正規化には `threadTs` / `messageTs` / `permalink` を追加収集する。
  - Slack 読み取りは `customTools` 経由の `play-slack-search` だけに絞る。
  - AI の結果は `no_action | draft_reply | needs_review` に正規化するが、独立した decision store には保存せず transcript や UI 表示に残す。
  - v1 では Slack 送信口は持たず、返信が必要な場合は draft reply の生成までに留める。
  - `play-slack-search` の `spawn adapter` は 3 分 timeout を持ち、timeout 時は run 全体を落とさず `needs_review` に変換する。
  - heartbeat は `vendor/openclaw` と同じく main セッションで走る full turn とし、busy 時は割り込まず skip して後で再試行する。`HEARTBEAT_OK` 以外の有意味な応答は main に heartbeat 応答として識別可能な形で残す。

## 2. 仕様と受け入れ条件 Specification and Acceptance Criteria

### 2.1 スコープ Scope

- 今回やること
  - 自分宛メンション通知を即時 AI 起動トリガーとして扱う契約を定義する
  - `self post` / `self reaction` を日次ファイル保存の record-only self activity として扱う方針を定義する
  - Slack 通知専用の `ActivityFeed` を UI view として定義する
  - Slack 通知起点 run の既定 session を `slack-activity` に固定し、`threadTs` / `messageTs` は Slack 参照の anchor として扱う規約を明文化する
  - 現行 notification 正規化契約へ `teamId` / `threadTs` / `messageTs` / `permalink` を追加する調査と調整を計画に含める
  - `play-slack-search` を現行 `customTools` に `spawn adapter` で組み込む
  - AI の結果を `no_action | draft_reply | needs_review(replyText?)` に正規化する
  - `vendor/openclaw` 相当の heartbeat を main セッション上の full agent turn として有効化する
  - 仕様・図・テストを OpenClaw 寄せ前提に整理する
- 成果物
  - 実装: `src/collector-slack/*`, `src/control-plane/*`, `src/assistant/*`
  - View: `ActivityFeed`（Slack 通知専用の unread-like view。v1 では既読管理なし）
  - テスト: unit / integration / contract
  - ドキュメント: `doc/spec.md` 必要差分、今回の計画書
- 制約
  - v1 は Slack source のみ対象
  - 即時 AI 起動入力は「自分宛メンション通知」と「手動 user message」のみ
  - DM はメンションがなくても v1 の即時 AI 起動対象にしない
  - `self post` / `self reaction` は記録のみで即時 AI 起動には使わない
  - 現行 notification に不足している `teamId` / `threadTs` / `messageTs` / `permalink` は collector 側の拡張で補う前提とする
  - anchor が解決できない通知は自動送信しない
  - durable replay、idempotency、Slack 送信、exactly-once delivery は v1 の責務にしない
  - heartbeat は main セッション上で動かし、`vendor/openclaw` 相当のシンプルな full turn に寄せる
  - ActivityFeed は専用 AI セッションではなく、Slack 通知専用の read-only view とする

### 2.2 非スコープ Non Scope

- Slack 全メッセージ・reaction・channel post の常時収集
- 他人同士の post / reaction の常時記録
- DM を通知起点の即時 AI run 対象に戻すこと
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
- ユーザー操作用の独立した Slack Activity 画面スレッド
- GitHub / Jira など他 source の取り込み

### 2.3 ユースケース Use Cases

- 正常系1: 自分宛メンション通知を受けて thread を取得し、返信案を生成する
  - AI が `play-slack-search(mode=thread)` で thread を読み、`draft_reply` を返す
- 正常系2: 自分宛メンション通知を受けるが返信不要と判断する
  - AI が thread を確認し、`no_action` を返す
- 正常系3: 自分宛ではない通知が到着する
  - v1 では即時 run を起動せず、通知起点の処理対象にしない
- 正常系3-補足: DM 通知が到着する
  - v1 では自分宛メンション通知に含めず、即時 run を起動しない
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

1. Given 自分宛メンション通知が到着する  
   When 通知処理が開始される  
   Then 即時 AI run が `slack-activity` セッションで起動する
2. Given 通知に `messageTs` しかない  
   When `play-slack-search(mode=message)` で親 thread を解決する  
   Then 解決成功時は thread anchor を使って文脈取得し、失敗時は `needs_review` に倒れる
3. Given 通知に `threadTs` と `messageTs` がなく `permalink` だけがある  
   When `play-slack-search(mode=permalink)` で anchor 解決を試みる  
   Then 解決成功時は取得した anchor で文脈取得し、失敗時は `needs_review` に倒れる
4. Given AI run が通知処理を開始する  
   When 文脈取得が必要になる  
   Then `play-slack-search` は `spawn adapter + customTools` 経由で呼ばれ、`thread/message/search/permalink` のいずれかの mode で結果を返す
5. Given AI が通知を評価し `draft_reply` または `needs_review(replyText?)` を返す  
   When run が完了する  
   Then replyText と判断理由が transcript または UI 表示から確認でき、Slack 自動送信は行われない
6. Given 自分宛メンションではない通知、self post、または self reaction が観測される  
   When collector が受理する  
   Then それらは record-only または無視として扱われ、即時 AI run は起動しない
7. Given heartbeat の定期時刻に main セッションが空いている  
   When heartbeat が起動する  
   Then `HEARTBEAT.md` または default prompt を使う full agent turn が main セッション上で実行される
8. Given heartbeat の定期実行中に `main` が busy、`HEARTBEAT.md` が実質空、または結果が `HEARTBEAT_OK` である  
   When heartbeat 実行結果を処理する  
   Then それぞれ `skip + 後再試行`、run skip、UI 既定フィルタの契約で扱われる
9. Given heartbeat が `HEARTBEAT_OK` 以外の有意味な出力を返す  
   When heartbeat 実行結果を main 側へ反映する  
   Then main transcript には heartbeat 応答であると識別できる形で表示される

### 2.5 既知の制約 Known Limitations

- 通知設定や Slack 側の仕様に依存するため、通知されない重要会話は即時経路では拾えない。
- 通知 snippet は不完全であり、正確な判断には追加の Slack 読み取りが前提となる。
- `messageTs` しかない通知は thread anchor 解決に追加 fetch が必要になる場合がある。
- `needs_review(replyText?)` を返しても、v1 では専用 review UI は持たない。
- heartbeat は main セッションを再利用するため、有意味な heartbeat turn は main 側の履歴に影響する。
- ActivityFeed は durable audit log ではなく、Slack 通知専用の UI view である。
- restart 後の未処理通知 replay や duplicate 吸収は保証しない。
- collector 側で `threadTs` / `messageTs` / `permalink` を取り切れない通知は `needs_review` に倒すしかない。

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
  - 即時 AI 起動対象は `NormalizedEvent(kind=notification)` のうち自分宛メンション notification のみ
  - `NormalizedEvent(kind=post|reaction)` の self event は record-only
- Tool I/O
  - `play_slack_search(mode, ...)`
  - 論理機能として `thread`, `message`, `search`, `permalink` を提供する
- heartbeat I/O
  - `HEARTBEAT.md` が存在すればその内容を heartbeat prompt の workspace context として利用する
  - `HEARTBEAT.md` が存在しなければ default heartbeat prompt を利用する
  - heartbeat 応答が `HEARTBEAT_OK` のみ、または同等の短い ACK の場合は無内容として扱う
  - heartbeat 応答が `HEARTBEAT_OK` 以外の有意味な出力を返した場合は、main transcript に heartbeat 応答として識別可能な形で残す
- HTTP API
  - 既存 `POST /api/commands`
  - 既存 heartbeat run / history API を利用するかは実装時に整理するが、durable history store 前提にはしない
  - `GET /api/activity-feed`
- 設定ファイル
  - `HEARTBEAT.md`
  - heartbeat 関連の既存 env var
- 永続化ストレージ
  - `self post` / `self reaction` は `state/activity/self/YYYY-MM-DD.jsonl` へ日次保存する
  - v1 の標準経路ではそれ以外の dedicated durable SoT を追加しない
- UI View
  - `ActivityFeed`（Slack 通知専用）
- 外部サービス連携
  - Slack Desktop CDP notification source
  - `play-slack-search`

### 4.2 データモデルとスキーマ

- `SlackNotificationEvent`
  - 位置づけ: notification 処理のための軽量 projection
  - `teamId`
  - `channelId`
  - `threadTs?`
  - `messageTs?`
  - `actorId?`
  - `title?`
  - `snippet?`
  - `permalink?`
  - `sessionKey` 既定値は `slack-activity`
  - `isDirectMention: boolean`
  - `mentionTargetUserId?`
- `SelfActivityEvent`
  - 位置づけ: self event の lightweight activity view
  - `teamId`
  - `kind: "post" | "reaction"`
  - `channelId`
  - `threadTs?`
  - `messageTs?`
  - `messageText?` reaction 時点のスナップショット
  - `emoji?`
  - `action?`
  - `sessionKey` 既定値は `slack-activity`
  - 保存先: `state/activity/self/YYYY-MM-DD.jsonl`
- `slack-activity` セッション規約
  - Slack 通知起点 run は thread/channel ごとに session を分離せず、既定で `slack-activity` セッションへ集約する
  - `threadTs` は thread 文脈取得用の最優先 anchor として扱う
  - `messageTs` しかない場合は `play-slack-search(mode=message)` で親 thread を解決し、成功時は文脈取得に使う
  - `threadTs` と `messageTs` がともに無い場合は `permalink` を fallback anchor 候補として扱い、解決できなければ `needs_review` に倒す
  - `messageTs` から anchor 解決失敗した場合は `needs_review` に倒す
- `PlaySlackSearchRequest`
  - `mode: "thread" | "message" | "search" | "permalink"`
  - `channelId?`
  - `threadTs?`
  - `messageTs?`
  - `permalink?`
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
  - `kind: "notification_received" | "draft_reply" | "needs_review" | "no_action" | "note"`
  - `messageText`
  - `title`
  - `summary?`
  - `sessionKey?`
  - `permalink?`
  - `status?`
  - `NotificationDecision.action=no_action` は `ActivityItem.kind=no_action` として投影する

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
  - `play-slack-search` の timeout は 180000ms（3分）とする
  - timeout 時は run 全体を落とさず `needs_review` に変換する
- ログ方針と個人情報の扱い
  - `sessionKey`, `decision.action`, `heartbeat run status` を構造化ログ出力する
  - Slack 本文全文や token はログへ出さない

### 4.4 代表的な例 Examples

- 例1: 自分宛メンション通知から draft reply を作る

```json
{
  "channelId": "C123",
  "isDirectMention": true,
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
- `ActivityFeedBuilder` への書き込みは `NotificationRunCoordinator` に集約し、Router は分類と session 決定だけを担う。

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
    +appendNotification(event)
    +dispatch(event)
    +normalizeDecision(runResult)
    +publishDraft(decision)
    +appendDecision(decision)
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
  participant Coord as NotificationRunCoordinator
  participant Worker as WorkerSupervisor
  participant Tool as play-slack-search(spawn)
  participant Heartbeat as OpenClawStyleHeartbeatRunner
  participant Feed as ActivityFeedBuilder

  CDP->>Router: notification
  Router->>Coord: classified notification
  alt isDirectMention == true
    Coord->>Feed: append notification_received
    Coord->>Worker: session/prompt(meta: sessionKey=slack-activity, notification)
    Worker->>Tool: play_slack_search(...)
    Tool-->>Worker: context
    Worker-->>Coord: NotificationDecision
    alt action == draft_reply
      Coord->>Feed: append draft_reply
    else action == needs_review / no_action
      Coord->>Feed: append needs_review/no_action
    end
  else isDirectMention == false
    Coord-->>Coord: no immediate run
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
  - `isDirectMention` / `mentionTargetUserId` 判定
  - self post / self reaction が record-only になること
  - self reaction に反応先メッセージ本文が保持されること
  - `ActivityItem` unread-like view 生成
  - `play-slack-search` spawn adapter の mode 別入力 validation
  - permalink fallback anchor 解決
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
  - `ActivityItem` unread-like view 契約
  - `play-slack-search` spawn adapter の I/O contract
  - `GET /api/activity-feed` 契約

### 6.2 カバレッジ対象

- 重要ロジック
  - 自分宛メンション notification の判定
  - self event の record-only 分岐
  - self reaction の本文スナップショット保持
  - `messageTs` しかない通知の anchor 解決
  - permalink fallback の anchor 解決
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
  - 自分宛メンション判定の境界

## 7. 実装タスクリスト Implementation Plan

### Phase 1 設計と準備

- [ ] 自分宛メンション notification 判定契約を確定する
- [ ] notification 正規化へ `teamId` / `threadTs` / `messageTs` / `permalink` を追加収集する調査結果を反映する
- [ ] `SlackNotificationEvent` projection 契約と `slack-activity` セッション規約を確定する
- [ ] `SelfActivityEvent` の日次ファイル保存契約と `ActivityItem` の最小 view 契約を確定する
- [ ] `ActivityFeed` の unread-like 表示と「既読状態を持たない」契約を確定する
- [ ] heartbeat の OpenClaw 寄せに伴う既存 `/api/heartbeat/*` と SSE の互換方針を確定する
- [ ] `GET /api/activity-feed` の response 契約を確定する
- [ ] `play-slack-search` の `spawn adapter` 契約を確定する
- [ ] `NotificationDecision=no_action|draft_reply|needs_review(replyText?)` 契約を確定する
- [ ] heartbeat を OpenClaw 互換の `HEARTBEAT.md + HEARTBEAT_OK + skip/retry` 契約に固定する
- [ ] spec から replay / idempotency / durable SoT 前提を落とす差分方針を確定する
- [ ] transcript 日付切替を別計画に切り出す前提で影響範囲を調査する
- [ ] `src/control-plane/http/chat-history-store.ts` の単一 `chat-history.jsonl` 前提への影響を調査する
- [ ] `src/assistant/markdown-summary-batch.ts` の watermark / transcript 増分読込 / truncate-reset 前提への影響を調査する
- [ ] transcript path を参照する unit / integration テストの追従箇所を洗い出す
- [ ] main transcript へ heartbeat 応答を残す契約と transcript rotate の整合を調査する
- [ ] transcript 日付切替を別計画（例: `260310-s02-transcript-daily-rotation.md`）として切り出すためのタスク分解を行う

### Phase 2 通知処理と activity view の実装

- [ ] Test notification projection と `slack-activity` セッション固定の失敗テストを追加する Red
- [ ] Test notification 正規化が `teamId` / `threadTs` / `messageTs` / `permalink` を保持する失敗テストを追加する Red
- [ ] Impl notification projection の最小実装を追加する Green
- [ ] Test self reaction の本文スナップショット保持に関する失敗テストを追加する Red
- [ ] Test self activity の日次ファイル保存に関する失敗テストを追加する Red
- [ ] Impl self activity の日次ファイル保存を追加する Green
- [ ] Test ActivityFeed の notification 表示に関する失敗テストを追加する Red
- [ ] Impl `ActivityItem` view の最小実装を追加する Green
- [ ] Impl `GET /api/activity-feed` の最小実装を追加する Green
- [ ] Docs ActivityFeed を durable SoT ではなく UI view として更新する

### Phase 3 `play-slack-search` spawn adapter 統合

- [ ] Test `play-slack-search` の `customTools` 登録と `thread/message/search` mode の失敗テストを追加する Red
- [ ] Test `play-slack-search(mode=permalink)` の失敗テストを追加する Red
- [ ] Impl `play-slack-search` spawn adapter を `src/assistant/agent-session-factory.ts` 系へ最小実装する Green
- [ ] Refactor `play-slack-search` timeout 180000ms と error UX を整理する
- [ ] Refactor spawn adapter とエラーマッピングを整理する
- [ ] Integration `customTools` 経由で `play-slack-search` が spawn される統合テストを追加する
- [ ] Docs tool I/O と contract boundary を更新する

### Phase 4 通知 run と draft reply の実装

- [ ] Test `NotificationDecision` 正規化と `draft_reply` / `needs_review` の失敗テストを追加する Red
- [ ] Test permalink fallback から `needs_review` へ倒れる失敗テストを追加する Red
- [ ] Impl AI run 起動と draft reply 生成の最小実装を行う Green
- [ ] Refactor notification run と UI 表示連携を整理する
- [ ] Integration 通知 -> thread/permalink 解決 -> decision の統合テストを追加する

### Phase 5 heartbeat の OpenClaw 寄せ実装

- [ ] Test `HEARTBEAT.md` missing / effectively empty / `HEARTBEAT_OK` / meaningful output / busy retry の失敗テストを追加する Red
- [ ] Test `/api/heartbeat/*` と SSE の互換方針に関する失敗テストを追加する Red
- [ ] Impl heartbeat を OpenClaw 互換の main session full turn に寄せる Green
- [ ] Impl meaningful heartbeat output を main transcript に heartbeat 応答として表示する Green
- [ ] Refactor heartbeat と UI 表示の責務分離を整理する
- [ ] Integration heartbeat 定期実行の統合テストを追加する

## 8. Definition of Done

### 8.1 機能DoD Functional DoD

- [ ] 自分宛メンション notification で即時 AI run が起動すること
- [ ] `play-slack-search` が `customTools` 経由で利用できること
- [ ] self post / self reaction が record-only として扱われること
- [ ] self post / self reaction が `state/activity/self/YYYY-MM-DD.jsonl` に日次保存されること
- [ ] self reaction が反応先本文スナップショットを保持できること
- [ ] 返信が必要なケースで draft reply が生成できること
- [ ] heartbeat が OpenClaw 互換の `HEARTBEAT.md + HEARTBEAT_OK + skip/retry` 挙動を示すこと
- [ ] `HEARTBEAT_OK` 以外の heartbeat 応答が main transcript で識別可能に表示されること
- [ ] ActivityFeed で Slack 通知の unread-like 一覧が表示できること

### 8.2 品質DoD Quality DoD

- [ ] unit / integration / contract テストが追加されていること
- [ ] `pnpm check` が通ること
- [ ] replay / idempotency / durable SoT 前提の古い記述が plan から除去されていること
- [ ] `doc/spec.md` に反映すべき差分が洗い出されていること

## 9. 懸念事項と未確定事項 Concerns and Questions

- `ActivityFeed` は unread-like view として扱うが、v1 では既読状態を保存しない。
- `play-slack-search` の `spawn adapter` は外部コマンド障害の影響を受けるため、timeout は 180000ms に固定し、timeout/error 時の UI 表示文言は実装で詰める必要がある。
- transcript は長期運用で肥大化する可能性がある。日付切替は本計画では実装せず、別計画で影響範囲を調査する。
- heartbeat は OpenClaw 寄せで `main` に残るため、有意味な heartbeat turn が main の履歴へ混ざる点はプロトタイプとして許容する。
- collector が自分宛メンション通知を判定するために必要な情報をどこまで CDP から安定取得できるかは、Phase 1 の調査で確認が必要である。
- transcript 日付切替を導入する場合、少なくとも以下の影響範囲を別計画で調査する必要がある。
  - `src/control-plane/http/chat-history-store.ts` の単一 `chat-history.jsonl` 前提
  - `src/assistant/markdown-summary-batch.ts` の transcript 増分読込 / watermark / truncate-reset 前提
  - `tests/unit/assistant/markdown-summary-batch.test.ts` と `tests/integration/phase-b-memory-sandbox-audit.test.ts` の単一 transcript path 前提
  - main transcript に heartbeat 応答を残す表示契約との整合
  - transcript path / rotate 規約を参照する UI・API・補助ジョブの追従
