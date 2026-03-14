# 260307-s01: Message / Event Flow vNext 要求仕様

## 0. Core Principles

- File First: 外部入力は AI 実行前に必ず永続化し、正本は JSONL / Markdown に置く。
- Separation of Concerns: `イベント処理レーン` と `会話セッション` を分離し、queue の責務と会話文脈の責務を混ぜない。
- Session Is Local Context: session は局所会話文脈の単位であり、共有データベースとして扱わない。
- Shared Knowledge via Artifacts: session 間の相互参照は live state ではなく、`timeline` / `memory` / `snapshot` の artifact 経由で行う。
- Hub-and-Spoke: `main` は全入力の受け皿ではなく、共有知識の管理と横断判断の hub として扱う。Slack thread / channel は spoke として扱う。
- Notification Lane, Not Notification Session: 通知の交通整理は専用 queue / router で行い、単一の通知専用 AI session は作らない。
- Idempotency First: event / task / delivery の各境界で dedupeKey / idempotencyKey により再処理を吸収する。
- Fail Closed: classifier や routing 補助が不確実な場合は `note` または `defer` に倒し、不要な自律返信を避ける。

## 1. 概要と目的 Overview and Purpose

- What
  - Slack イベント、ユーザーメッセージ、heartbeat signal を同じ骨格で扱える vNext の要求仕様を定義する。
  - `session` と `shared knowledge` の責務分離を明文化し、`main` 偏重の構成を見直す。
  - AI run の入力を `TaskEnvelope` と `ContextBundle` に正規化し、出力を `RunOutcome` として構造化する。
- Why
  - 現状の設計は `memoryScope=main|spoke` に session 種別、権限、知識アクセスが同居しており、仕様拡張時の見通しが悪い。
  - 「通知を main に集約するか」「spoke に分けると参照できないか」という論点が、queue 設計と knowledge 設計の混線で議論しづらい。
  - session 間の live state 参照を許す設計は replay / recovery / audit / determinism を悪化させる。
- How
  - 処理を `Capture -> Record -> Route -> Build Context -> Execute -> Interpret Outcome -> Persist -> Deliver / Handoff / Summarize` の 1 本に統一する。
  - session モデルを `ConversationScope`、知識アクセスを `KnowledgeAccess`、run の目的を `ExecutionProfile` で表す。
  - `main` は shared-write を担う hub、Slack thread/channel は shared-read を持つ spoke として扱う。

## 2. 仕様と受け入れ条件 Specification and Acceptance Criteria

### 2.1 スコープ Scope

- 今回定義すること
  - 共通イベント処理フローの要求仕様
  - `ConversationScope` / `KnowledgeAccess` / `ExecutionProfile` の概念定義
  - `RoutingDecision` / `TaskEnvelope` / `ContextBundle` / `RunOutcome` の要求契約
  - `main` / `spoke` の責務分担
  - Slack event、user chat、heartbeat の標準フロー
  - shared knowledge 参照と更新の権限モデル
  - replay / recovery / idempotency の不変条件
- 今回の対象
  - Slack collector 由来イベント
  - control-plane API 由来の user message
  - heartbeat / flusher などの system signal
  - timeline / memory / snapshot を用いた artifact ベース参照
- 成果物
  - 本要求仕様書
  - 後続の `doc/spec.md` / `doc/spec-vnext-draft.md` 反映のための基準契約
  - 実装フェーズで利用する acceptance criteria

### 2.2 非スコープ Non Scope

- マルチホスト分散キュー化
- provider / model の本格的な自動最適化
- GitHub / Jira など Slack 以外の source 詳細設計
- UI での高度な handoff 可視化や policy 編集画面
- live な session 間 state 共有
- LLM 間協調そのものを第一級概念にすること

### 2.3 ユースケース Use Cases

- 正常系1: Slack DM を即時 spoke run へ渡す
  - DM は conversationScope を DM 単位で解決し、低遅延で `dispatch_spoke` される。
- 正常系2: Slack channel post を蓄積し、まとめて spoke run する
  - channel post は attention window を経由し、必要時のみ `dispatch_spoke` される。
- 正常系3: thread をまたぐ判断が必要な場合に main へ handoff する
  - spoke run は構造化された `escalate_to_main` outcome を返し、main が横断判断を行う。
- 正常系4: user が特定 thread へ送信したメッセージをそのまま spoke run する
  - UI からの command は対象 thread の conversationScope へ直接 dispatch される。
- 正常系5: heartbeat が重要 signal を検出したときのみ main run を起動する
  - heartbeat は常時会話するのではなく、signal を生成し、閾値超過時のみ `dispatch_main` する。
- 異常系1: classifier が timeout / invalid output になる
  - route は `note` または `defer` へ fail-closed し、AI run を起動しない。
- 異常系2: 再起動後に inbox/timeline を replay する
  - dedupeKey / idempotencyKey により二重 run / 二重送信を防ぐ。

### 2.4 受け入れ条件 Acceptance Criteria

1. Given 外部イベントまたは user message が到着する  
   When AI run 前処理が始まる  
   Then run 起動前に正規化レコードが inbox / timeline へ永続化される
2. Given Slack thread/channel ごとの conversationScope が解決される  
   When routing が `dispatch_spoke` を返す  
   Then target scope のみが会話履歴を更新し、他 scope の live session state は参照されない
3. Given spoke run が共有知識を必要とする  
   When context を構築する  
   Then shared knowledge は artifact ベースの read-only 参照で供給される
4. Given spoke run が thread 横断の判断を必要とする  
   When outcome を返す  
   Then `escalate_to_main` として構造化 handoff が保存され、main 側 task が enqueue される
5. Given main run が shared memory を更新する必要がある  
   When update を実行する  
   Then shared-write capability を持つ run のみが更新を行う
6. Given classifier / policy 補助が不確実である  
   When route が確定する  
   Then `note` または `defer` に倒れ、不要な自律返信は送信されない
7. Given 同一 conversationScope に実行中 run が存在する  
   When 新しい run を同 scope へ dispatch する  
   Then 同 scope は直列に保たれ、別 scope の run は継続する
8. Given プロセス再起動や replay が発生する  
   When 同一 event / task / delivery が再度観測される  
   Then dedupeKey / idempotencyKey で二重処理が吸収される

### 2.5 既知の制約 Known Limitations

- 同一 conversationScope 内の turn は直列であり、同時実行はしない。
- artifact ベース参照は live context 共有より安全だが、反映遅延が発生しうる。
- shared-write を絞るため、spoke 単独では knowledge 更新が完結しない場合がある。
- 初期段階では Slack source を優先し、他 source の route policy は一般化しない。

## 3. 用語と概念モデル Domain Model

### 3.1 ConversationScope

- 定義
  - AI が局所会話文脈として扱う単位。
- 例
  - `main`
  - `slack:D123`
  - `slack:channel:C123`
  - `slack:channel:C123:thread:1741160000.000100`
- 役割
  - transcript の保存単位
  - same-scope serial execution の単位
  - UI thread / session の論理対応単位

### 3.2 KnowledgeAccess

- 定義
  - run が参照・更新できる知識領域の権限セット。
- 初期レベル
  - `local-only`
  - `shared-read`
  - `shared-write`
- ルール
  - `spoke` は原則 `shared-read`
  - `main` は `shared-read + shared-write`
  - `system` profile は用途限定で `shared-read`

### 3.3 ExecutionProfile

- 定義
  - run が何の目的で起動されたかを表す分類。
- 初期値
  - `user_chat`
  - `proactive_event`
  - `heartbeat`
  - `handoff`
  - `summary`
- 役割
  - system prompt、tool allowlist、delivery policy の選択に使う

### 3.4 RoutingDecision

- 初期アクション
  - `drop`
  - `note`
  - `dispatch_spoke`
  - `dispatch_main`
  - `dispatch_spoke_then_handoff_main`
  - `defer`
- 不変条件
  - routing は conversationScope と knowledgeAccess と executionProfile を同時に確定する。
  - routing は idempotent でなければならない。

### 3.5 TaskEnvelope

- 定義
  - run 起動前に queue へ積む単位。
- 必須項目
  - `taskId`
  - `originEventId`
  - `targetConversationScope`
  - `knowledgeAccess`
  - `executionProfile`
  - `reason`
  - `dedupeKey`

### 3.6 ContextBundle

- 定義
  - AI run に注入する、artifact ベースの参照束。
- 必須要素
  - `threadSnapshotRef`
  - `recentEventRefs`
  - `sharedFactRefs`
  - `policyHints`
- 任意要素
  - `relatedRunRefs`
  - `handoffPayload`
  - `deliveryContext`

### 3.7 RunOutcome

- 定義
  - AI run の結果を後段が解釈可能な形にした構造。
- 初期アクション
  - `no_action`
  - `note_only`
  - `draft_reply`
  - `send_reply`
  - `escalate_to_main`
  - `memory_candidate`
  - `schedule_followup`
- 不変条件
  - AI run の自由文出力だけでは後段処理を決定しない。
  - delivery / handoff / memory update は RunOutcome の構造に従って行う。

## 4. 標準処理フロー Canonical Flow

1. Capture
   - Slack collector、HTTP API、heartbeat scheduler が入力を受ける。
2. Normalize
   - 入力を共通 envelope に変換し、conversationScope 候補と dedupeKey を与える。
3. Persist First
   - inbox と timeline に append する。AI はまだ起動しない。
4. Route
   - policy / classifier / source 種別に応じて RoutingDecision を確定する。
5. Build Task
   - RoutingDecision から TaskEnvelope を作り queue へ積む。
6. Build Context
   - TaskEnvelope に基づき ContextBundle を artifact から構築する。
7. Execute
   - targetConversationScope の session へ run を投げる。
8. Interpret Outcome
   - AI の出力を RunOutcome に正規化する。
9. Persist Outcome
   - transcript、audit、timeline action、handoff candidate、memory candidate を保存する。
10. Deliver / Handoff / Summarize

- reply 送信、main handoff、shared memory 更新候補の反映を行う。

## 5. ソース別フロー Requirements by Source

### 5.1 Slack Event

- DM
  - 原則 `dispatch_spoke`
  - low-latency queue を通す
- channel mention
  - 原則 `dispatch_spoke`
  - 横断判断が必要なら `dispatch_spoke_then_handoff_main`
- thread reply
  - 原則 `dispatch_spoke`
- reaction
  - 原則 `note`
  - policy 一致時のみ `dispatch_spoke`
- generic notification
  - 原則 `note`
  - task / blocker / incident など重要 signal のみ `dispatch_spoke` または `dispatch_main`

### 5.2 User Message

- UI / API から受けた message は target thread を明示できること
- thread 指定あり
  - 指定 conversationScope へ直接 dispatch する
- thread 指定なし
  - 既定 `main`
- user message は `executionProfile=user_chat` として扱う

### 5.3 Heartbeat Signal

- heartbeat は常時会話する主体ではなく、まず signal generator として扱う
- heartbeat の出力は構造化 signal とし、即座に AI 自律返信しない
- signal が閾値超過時のみ `dispatch_main`
- 将来 thread 単位 heartbeat を許可する場合も、最初に signal 化してから task 化する

## 6. Hub-and-Spoke 要求仕様

### 6.1 Main (Hub)

- 責務
  - shared knowledge の管理
  - 複数 thread をまたぐ優先順位判断
  - escalation / handoff の処理
  - 長期記憶更新の最終判断
- 権限
  - `shared-read`
  - `shared-write`
- 禁止事項
  - 外部イベントの既定流入先として使わない

### 6.2 Spoke

- 責務
  - thread / channel ごとの局所会話
  - 局所コンテキストに閉じた返信判断
  - 横断判断が必要なときの handoff 生成
- 権限
  - `shared-read`
  - `shared-write` は原則不可
- 禁止事項
  - 他 spoke の live state 参照

## 7. Shared Knowledge 要求仕様

- shared knowledge は session 内部ではなく artifact として管理する
- 初期参照対象
  - `timeline`
  - thread snapshot
  - shared memory
  - prior run summary
- 参照ルール
  - spoke も read-only 参照できる
  - direct session-to-session read は禁止
- 更新ルール
  - shared-write capability を持つ run のみが shared memory を更新できる
  - spoke は `memory_candidate` を返し、反映は main または専用 writer path が行う

## 8. Recovery / Replay / Audit 不変条件

- inbox append 成功前に run を起動しない
- timeline append に失敗しても raw input の正本は保持される
- replay 時に event / task / delivery の dedupe が効くこと
- audit は run 開始、run 終了、delivery、handoff を最低限記録する
- handoff も append-only artifact として追跡可能であること

## 9. データ契約 Draft

### 9.1 TaskEnvelope 例

```json
{
  "taskId": "task_01",
  "originEventId": "evt_01",
  "targetConversationScope": "slack:channel:C123:thread:1741160000.000100",
  "knowledgeAccess": "shared-read",
  "executionProfile": "proactive_event",
  "reason": "mention in active thread",
  "dedupeKey": "slack:C123@1741160000.000100:mention"
}
```

### 9.2 ContextBundle 例

```json
{
  "conversationScope": "slack:channel:C123:thread:1741160000.000100",
  "threadSnapshotRef": "state://threads/slack:channel:C123:thread:1741160000.000100/snapshot",
  "recentEventRefs": ["state://timeline/offset/12001", "state://timeline/offset/12002"],
  "sharedFactRefs": ["memory://shared/daily/2026-03-07#L12", "memory://shared/long-term#L88"],
  "policyHints": {
    "priority": "normal",
    "deliveryMode": "draft_or_send"
  }
}
```

### 9.3 RunOutcome 例

```json
{
  "action": "escalate_to_main",
  "summary": "This thread needs cross-project prioritization.",
  "handoff": {
    "targetConversationScope": "main",
    "reason": "cross-thread prioritization required"
  }
}
```

## 10. 既存設計からの移行指針

- `sessionKey` ベースの per-thread conversationScope は維持する
- `main` への既定 dispatch は廃止し、明示 routing のみで main を使う
- `memoryScope=main|spoke` は将来的に `KnowledgeAccess` へ段階移行する
- shared-read tool を spoke へ開放し、shared-write は引き続き絞る
- heartbeat は `main` 固定 run から段階的に signal-first へ寄せる

## 11. 未解決事項 Open Questions

- shared knowledge の read API を `memory_search_shared` / `timeline_search` / `snapshot_get` のどこまでに分けるか
- `dispatch_spoke_then_handoff_main` を router の第一級 action にするか、RunOutcome でのみ表現するか
- user が UI から main と spoke をどう切り替えるか
- delivery を `draft` と `send` に分ける境界を policy でどう管理するか
