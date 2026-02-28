# Adjutant 新アーキテクチャ仕様案（Draft）

Status: Draft  
Last Updated: 2026-02-27

## 関連ドキュメント

- 実装プラン: `doc/plan/260228-s01-file-queue-ipc-foundation.md`

## 1. 目的

本仕様は、既存実装を UNIX 哲学に沿って再設計するための vNext 案である。  
目標は次の 3 点。

1. 役割ごとの責務分離を明確にする。
2. 入出力をテキストストリーム/ファイルキューに統一する。
3. Slack 以外（GitHub/Jira）への将来拡張を低コスト化する。

## 2. 設計原則

1. 1 コンポーネント 1 責務。
2. コンポーネント間 I/O は NDJSON（1 行 1 JSON）を基本とする。
3. Source of Truth はファイル（JSONL/Markdown）で保持する。
4. Queue は at-least-once 配信を前提とし、重複排除は dedupeKey/idempotency で行う。
5. Queue の低遅延通知は IPC を使うが、正本はファイルキューに固定する。
6. 過分割を避け、運用上の起動エントリポイントは最小限（2-3）に抑える。

## 3. ランタイム構成（初期案）

常駐プロセスは以下を基本とする。

1. `adjutant-supervisor`（親プロセス、子プロセス管理 + IPC 中継）
2. `ui`（Web 表示専用）

`adjutant-supervisor` は以下の論理ワーカーを子プロセスとして起動する。

1. `collector`
2. `assistant-gateway`
3. `deliver-*`

補助ジョブは sidecar として追加可能。

1. `heartbeat`
2. `flush-pending`
3. `memory-index`

## 4. 全体フロー

```text
[collector-*] -> inbox queue(JSONL) -> [assistant-gateway] -> outbox queue(JSONL) -> [deliver-*]
        |                ^                      |                 ^
        +-- send() ---->[adjutant-supervisor] <-send()-----------+
                          |                          |
                          +---- message notify ------+
                                                  |
                                                  +-> state/timeline/session transcripts

[ui] <-> assistant-gateway(API: commands/snapshot/events)
```

## 5. Queue モデル

### 5.1 Queue 種別

1. `inbox`: 収集イベント用
2. `outbox`: 外部サービスへの配信指示用
3. `dlq`: 再試行上限超過/恒久失敗用

### 5.2 ディレクトリ例

```text
state/
  queue/
    inbox/
      slack/
      github/
      jira/
    outbox/
    dlq/
  cursor/
    assistant-gateway.inbox-slack.json
    deliver-slack.outbox.json
```

### 5.3 読み取り保証

1. consumer は `segment + byteOffset` cursor で進捗管理する。
2. 処理成功後にのみ cursor を commit する。
3. 失敗時は cursor を進めない（再処理）。
4. 重複は `dedupeKey` で吸収する。

### 5.4 IPC 通知（低遅延）

1. producer 子プロセスは append 成功後に `process.send()` で notify を親へ送る。
2. 親（`adjutant-supervisor`）は宛先 worker へ `child.send()` で notify を中継する。
3. consumer 子プロセスは notify 受信時に EOF まで drain する。
4. 通知経路は `child_process.spawn/fork` の `ipc` チャネルに統一する（Windows/macOS/Linux）。
5. notify はヒント扱いであり、喪失しても整合性は壊れない。
6. consumer は定期 poll（既定 1000ms）を併用し、通知喪失時に自己回復する。

親子プロセス生成ルール:

1. 親は `spawn(..., { stdio: ["ignore", "pipe", "pipe", "ipc"] })` もしくは `fork()` を利用する。
2. 子は `process.on("message")` で受信し、`process.send()` で通知する。
3. 親プロセス再起動時も queue + cursor から回復できる設計を維持する。

notify payload（例）:

```json
{
  "type": "queue_appended",
  "queue": "inbox/slack",
  "segment": "20260227T123000Z-0007.open.jsonl",
  "hintOffset": 183420
}
```

supervisor relay payload（例）:

```json
{
  "type": "queue_notify",
  "queue": "inbox/slack"
}
```

## 6. ファイルローテーション方針（初期）

初期は単純化のため、**サイズ条件のみ**を採用する。

1. 書き込み先は `*.open.jsonl`。
2. `maxBytes` 超過で sealed ファイルへ rename。
3. sealed ファイルは読み取り専用扱い。
4. 全 consumer が既読になった sealed のみ GC 対象。

推奨初期値:

1. `maxBytes = 64MB`（開発時は 16MB でも可）
2. `retentionHours = 24`（既読セグメントのみ）

## 7. データ契約（最小）

### 7.1 Inbox（NormalizedEvent）

```json
{
  "id": "evt_01",
  "source": "slack",
  "kind": "post",
  "occurredAt": "2026-02-27T12:34:56.000Z",
  "loggedAt": "2026-02-27T12:34:56.120Z",
  "dedupeKey": "slack:C123@1730000000.123",
  "payload": {}
}
```

### 7.2 Outbox（Command）

```json
{
  "id": "cmd_01",
  "target": "slack",
  "action": "post_message",
  "args": {},
  "dedupeKey": "slack:post:C123:threadTs:hash",
  "attempt": 0,
  "maxAttempts": 5,
  "notBefore": "2026-02-27T12:35:00.000Z"
}
```

### 7.3 Cursor

```json
{
  "segment": "20260227T123000Z-0007.jsonl",
  "offset": 183420
}
```

## 8. ToolHub 方針

ToolHub は in-process のハブを維持し、個別ツールは外部コマンド拡張を許容する。  
初期方針は **毎回プロセス起動（spawn per call）**。

### 8.1 実行モデル

1. hub が tool call ごとに子プロセス起動。
2. `stdin` に 1 リクエスト JSON を送信。
3. `stdout` から 1 レスポンス JSON を受信。
4. `timeout/maxOutputBytes/maxConcurrent` を適用。

### 8.2 ツール I/O 例

Input:

```json
{"id":"call_123","tool":"memory_search","args":{"query":"..."}}
```

Output:

```json
{"id":"call_123","ok":true,"result":{"items":[]}}
```

Error:

```json
{"id":"call_123","ok":false,"error":{"code":"TIMEOUT","message":"...","retryable":true}}
```

## 9. UI 境界

UI は表示専用に寄せる。業務判断は gateway 側で実施する。

1. `POST /commands`: send_message, abort, heartbeat_run など
2. `GET /events/stream`: SSE でイベント購読
3. `GET /snapshot`: 初期表示データ取得

## 10. GitHub/Jira 拡張方針

core（assistant-gateway）は共通契約だけを扱い、source/sink 固有処理は adapter に閉じる。

### 10.1 入力追加

1. `collector-github`: Webhook/ポーリング -> inbox/github
2. `collector-jira`: Webhook/ポーリング -> inbox/jira

### 10.2 出力追加

1. `deliver-github`: outbox target=github のみ処理
2. `deliver-jira`: outbox target=jira のみ処理

## 11. 障害モデル

1. Queue は at-least-once 前提。
2. 一時失敗は retry（backoff）で再試行。
3. `maxAttempts` 超過で DLQ へ退避。
4. 冪等性は dedupeKey と外部 API の idempotency key で担保。
5. IPC notify 取りこぼしは poll で回復する前提とする。

## 12. 移行ステップ（推奨）

1. イベント/コマンド契約（JSON Schema）を固定する。
2. 既存 collector 相当を inbox 書き込みに変更する。
3. `adjutant-supervisor` を追加し、collector/gateway/deliver を子プロセス起動へ変更する。
4. assistant-gateway を inbox 読み + outbox 書きへ変更する。
5. Slack deliverer を outbox consumer 化する。
6. 親子 `ipc` チャネル通知を実装する（poll 併用）。
7. UI を commands/snapshot/events の 3 境界へ整理する。
8. GitHub/Jira adapter を段階追加する。

## 13. 非目標（この draft では扱わない）

1. 厳密 exactly-once 配信保証
2. 分散キュー（Kafka/NATS）への移行
3. マルチリージョン運用

## 14. オープン項目

1. Queue セグメント命名規則の最終確定
2. dedupeKey 生成規則の source 別標準化
3. command/action のバージョニング規約
4. DLQ の再投入オペレーション設計
5. `adjutant-supervisor` の再起動/子プロセス復旧ポリシー
