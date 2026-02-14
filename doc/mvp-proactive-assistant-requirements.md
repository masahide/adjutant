# Adjutant MVP要件定義案（Proactive AI Assistant）

- 作成日: 2026-02-14
- 対象: SlackイベントをJSONLへ保存し、`@mariozechner/pi-coding-agent` SDKでAIが読み込み、`assistant-ui` で対話できるMVP
- 前提ライブラリ:
  - `@assistant-ui/react` (`package.json` 反映済み)
  - `@mariozechner/pi-coding-agent` (`package.json` 反映済み)
- 参照実装:
  - `vendor/openclaw/src/auto-reply/heartbeat.ts`
  - `vendor/openclaw/src/web/auto-reply/heartbeat-runner.ts`
  - `vendor/openclaw/docs/gateway/heartbeat.md`
  - `vendor/openclaw/src/agents/pi-embedded-runner/run/attempt.ts`
- 調査メモ:
  - `doc/openclaw/doc0.md`
  - `doc/openclaw/doc1.md`
  - `doc/openclaw/doc2.md`

## 1. 背景と目的

### 1.1 背景

現行 Adjutant は Slack Desktop (CDP) からイベントを収集し、正規化して JSONL 保存できる。
一方で以下は未実装である。

- 保存したイベントをAIが継続的に読む仕組み
- プロアクティブ通知（Heartbeat）
- 人間がAIと双方向で対話するUI

### 1.2 目的

MVPでは、次を最短で成立させる。

1. Slackイベントを継続保存し、AIの入力コンテキストとして再利用する
2. Heartbeatにより、AIが定期的に状況確認して必要時のみ通知する
3. `assistant-ui` を使った対話画面で、ユーザーがAIと会話できる

## 2. MVPスコープ

### 2.1 実施すること（In Scope）

1. SlackイベントのJSONL永続化を正式な入力ソースとして定義
2. SystemEventQueue を介したイベント注入付きコンテキストローダー実装
3. `pi-coding-agent` SDKでのセッション実行基盤実装
4. OpenClaw準拠のHeartbeat契約を取り込んだ定期実行
5. `assistant-ui` 前提の最小チャットUI（送受信・ストリーミング表示）
6. セッション単位レーンでの排他制御（実行中追加はキュー待ち）
7. 実行失敗時の最小回復（1回再試行 + 入力切り詰め）
8. セッショントランスクリプトJSONLの永続化と再読込
9. ファイルベース簡易メモリ（`MEMORY.md` / `memory/YYYY-MM-DD.md`）の読み書き
10. ペルソナ定義ファイル（`SOUL.md`）による応答方針カスタマイズ
11. `GET /api/heartbeat/last` によるHeartbeat状態表示（MVPでは `main` セッション固定）

### 2.2 実施しないこと（Out of Scope）

1. 本番運用向けの厳密な権限管理・マルチテナント分離
2. 高度なRAG（ベクトルDBや再ランキング）
3. Slack以外のチャネル（GitHub/Discord等）の本格統合
4. 完全自律オートアクション（外部書き込みを自動実行）
5. モバイル最適化UI、デザインシステムの整備
6. ベクトルDB前提の高度メモリ（`memory-lancedb` 相当）の本実装
7. セッションメモリSQLite索引の本実装（実験機能相当）
8. 実行中ランへの steer（割り込み追加入力）
9. Hook拡張点（`before_agent_start` / `agent_end`）の提供
10. action承認API（`approve/reject`）とrun状態追跡API
11. `sessionKey` 指定でHeartbeat状態を返す拡張API
12. チャット実行中断API（`chat.abort` 相当）

### 2.3 識別子ルール（OpenClaw準拠）

- `sessionKey`: 実行ルーティングと排他制御のキー。CommandQueue と SystemEventQueue は必ず `sessionKey` 単位で扱う。
- `sessionId`: 会話履歴（トランスクリプト）を指す永続ID。`sessionKey -> sessionId` は 1:N で遷移しうる（リセットや再作成で新しい `sessionId` が作られる）。
- `runId`: 1回の実行（1リクエスト）を識別するID。ストリーミング購読と監査ログの相関に使う。
- 外部APIは `sessionId` 指定を受け付けてよいが、実行前に必ず `sessionKey` へ解決してからキュー投入する。
- API入力解決の優先順:
  1. `sessionKey` 指定時はそれを優先
  2. `sessionId` のみ指定時は `sessionId -> sessionKey` を引いて解決
  3. 両方指定で不整合な場合は `400 Bad Request`
  4. どちらも未指定時は `main` 用の既定 `sessionKey` を採用し、必要に応じて新規 `sessionId` を採番

## 3. 想定ユーザー体験（MVP）

1. バックグラウンドでSlackイベント収集が継続し、JSONLに追記される
2. ユーザーは `assistant-ui` 画面でAIに質問できる
3. AIは直近Slackイベントを読んだ上で回答する
4. 定期Heartbeatで「対応が必要なこと」だけ通知される
5. 問題なしの場合は `HEARTBEAT_OK` を扱い、不要通知は抑制される

## 4. 機能要件（FR）と受け入れ条件（AC）

### FR-01 Slackイベント収集とJSONL保存

- 入力: Slack CDPイベント（既存 `SlackAdapter` 系）
- 出力: 日付パーティション済み JSONL
  - 既定: `data/YYYY/MM/DD/slack/events.jsonl`
- 既存スキーマ `adjutant.event.v1.1` を継続利用
- 破損行の混入を防ぐため、1行1JSONを厳守

受け入れ条件:
- AC-01: Slackイベントが `adjutant.event.v1.1` 形式で追記保存される。

### FR-02 AIコンテキストローダー

- JSONLを読み、AI入力向けに「直近イベント窓」を抽出する
- SystemEventQueue（エフェメラル）を `sessionKey` 単位で保持し、次回ターン先頭で drain して前置き注入する
- 最小抽出条件:
  - 時間窓（例: 直近30分）
  - 件数上限（例: 最新200件）
  - チャネル/スレッド単位のフィルタ
- 出力はLLMに渡す中間構造へ正規化する
- 巨大入力はトークン上限を超えないように縮約する
- メモリ文脈（`MEMORY.md` と当日/前日メモ）を同時に組み込み、Heartbeatと通常対話の両方で参照可能にする

受け入れ条件:
- AC-02: AI応答時にJSONL由来文脈が入力へ取り込まれる。
- AC-13: SystemEventQueueの注入とdrainが正しく機能する。

### FR-03 pi-coding-agent SDK実行

- `pi-coding-agent` SDKでセッションを作成・継続する
- チャット要求時に以下を実行:
  1. セッション解決（`sessionId` 指定時は `sessionKey` へ解決）
  2. システムプロンプト組み立て
  3. FR-02のコンテキスト注入
  4. ストリーミング応答をUIへ中継

#### FR-03-1 OpenClaw準拠の実装参照要件（必須）

- 以下を規範実装として参照する。
  - `vendor/openclaw/src/agents/pi-embedded-runner/run/attempt.ts`
  - `vendor/openclaw/src/agents/pi-embedded-subscribe.ts`
- 以下の責務境界を崩さないこと。
  - セッション準備/修復（SessionManager）
  - 実行設定適用（SettingsManager）
  - 実行本体（createAgentSession）
  - ストリーミング購読とUI中継（subscribe）

#### FR-03-2 OpenClaw準拠のSDK利用手順（必須）

- 実行フローは次の順序を満たす。
  1. セッションファイルの排他ロック取得
  2. セッションファイル修復/事前準備後に `SessionManager` を開く
  3. `SettingsManager` を生成
  4. `createAgentSession` で実行セッションを構築
  5. 購読層でイベントを受信し、SSEイベントへ整形
  6. 実行終了時に `flush/dispose` とロック解放
- 例外時も 6 の後処理を `finally` 相当で必須とする。

#### FR-03-3 OpenClaw準拠のストリーミング契約（必須）

- イベント中継形式を以下で固定する（MVP）。
  - `run_started`: `{ runId, sessionId, sessionKey, seq }`
  - `text_delta`: `{ runId, delta, seq }`
  - `tool_call`: `{ runId, toolCallId, name, params, seq }`
  - `tool_result`: `{ runId, toolCallId, name, isError, result, seq }`
  - `text_end`: `{ runId, text, seq }`
  - `run_end`: `{ runId, status, seq }`
  - `error`: `{ runId, message, seq }`
- 内部イベントから公開SSEへの変換規則（OpenClaw参照）:
  - `stream: "lifecycle", phase: "start"` -> `run_started`
  - `stream: "assistant"` の増分 -> `text_delta`
  - `stream: "tool", phase: "start"` -> `tool_call`
  - `stream: "tool", phase: "result"` -> `tool_result`
  - アシスタント最終本文確定（message_end相当）-> `text_end`
  - `stream: "lifecycle", phase: "end"` -> `run_end`（`status: "completed"`）
  - `stream: "lifecycle", phase: "error"` -> `run_end`（`status: "failed"`）
  - 実行例外/購読例外 -> `error`（診断用）を送出した後、必ず `run_end`（`status: "failed"`）で終端する
- `run_end.status` はMVPでは `completed | failed` の2値に限定する。
- `tool_call` と `tool_result` の相関は `toolCallId` で行い、同一run内で同名ツールが複数回呼ばれても突合可能にする。
- `compaction` / `thinking` などMVP非対応ストリームは公開SSEへは流さず、デバッグログにのみ残す。
- `seq` は **公開SSEイベント列に対して** `runId` ごとに `1..N` の連番で再採番する（フィルタで破棄した内部イベントの `seq` は引き継がない）。
- 同一 `runId` 内では、公開SSEのすべてのイベントを `seq` 昇順で送信し、`text_end` は1回のみ送信する。
- `run_end` は `runId` ごとに1回のみ送信する。重複終端を検出した場合、2件目以降は公開SSEへ送らず内部診断ログに記録する。
- 公開SSEの終端判定は `run_end` のみを正とする（`error` は終端判定に使わない）。
- 受信側は公開SSEの `seq` 欠落/逆転を検知できること（`runId` 単位の順序保証）。
- 非ストリーミングモデルでは `text_delta` が0件のまま `text_end` のみ到着しうるため、UIは `text_end` 単独でも完了表示できること。

#### FR-03-4 同一セッション排他とキュー直列化（必須）

- 同一 `sessionKey` では同時に1ランのみ実行する。
- 実行レーンは `sessionKey` 単位で分離し、別セッション間でコンテキストやSystemEventが混線しないこと。
- 実行中に追加入力が来た場合は同一レーン待ち行列に積み、現行ラン完了後にFIFOで処理する。
- MVPでは実行中ランへの割り込み（steer）は行わない。

#### FR-03-5 実行失敗時の回復戦略（必須）

- 一時的失敗（通信/HTTP系）は1回のみ再試行する。
- コンテキスト超過時はイベント/履歴入力を新しい順に切り詰めて再試行する。
- compaction（要約圧縮）の独自実装はMVP対象外（SDK内部の自動compactionイベントは透過的に待機/継続）。
- モデル利用不可時は失敗を返し、フォールバックは任意（将来拡張）。
- 失敗後もセッションファイル破損を検知/修復できる設計とする。

受け入れ条件:
- AC-03: OpenClaw準拠のSDK実行手順で後処理まで必ず完了する。
- AC-04: 同一 `sessionKey` で同時実行が発生しない。
- AC-05: 異なる `sessionKey` 間で混線しない。
- AC-06: 一時失敗時に再試行/切り詰め再試行が動作する。
- AC-19: 致命的エラー時は `error`（診断用）を送出しつつ、最終的に `run_end(status: "failed")` で終端し、UI側で終端を一意に判定できる（`run_end` は `runId` ごとに1回のみ）。
- AC-21: 同一 `sessionKey` で同一 `clientMessageId` が再送された場合、重複runを作らず既存 `runId` を返す（冪等TTL内）。

### FR-04 Heartbeat（OpenClaw準拠のMVP版）

OpenClaw参照仕様を、MVPに必要な範囲で採用する。

#### FR-04-1 基本契約

- 定期実行間隔の既定値は `30m`（OpenClaw同様、認証モードによっては `1h` 既定へ切り替える余地を残す）
- Heartbeatプロンプト既定値:
  - `Read HEARTBEAT.md if it exists ... If nothing needs attention, reply HEARTBEAT_OK.`
- Heartbeat実行時の送信Body末尾に `Current time: <formattedTime> (<userTimezone>)` を1行注入する（時刻依存判断の安定化）。
- 送信Bodyにすでに `Current time:` 行が含まれる場合、同じ実行で重複挿入しない。
- `HEARTBEAT_OK` を「問題なし」トークンとして扱う
- **実行結果契約（OpenClaw準拠）**:
  - `status` は `ran` / `skipped` / `failed` の3値のみ
  - `HeartbeatRunResult` は次の判別可能 union とする:
    - `{ status: "ran"; durationMs: number }`
    - `{ status: "skipped"; reason: string }`
    - `{ status: "failed"; reason: string }`
  - モデルを呼び出した場合は、通知抑制時でも `status: "ran"` とする
  - `HeartbeatRunResult` では抑制理由を分岐させず、抑制種別は別のイベントログ（`HeartbeatEventPayload.status/reason`）で記録する
  - `status: "skipped"` は主にモデル呼び出し前スキップで使う
  - ただし OpenClaw準拠として、モデル呼び出し後でも配信チャネル未準備（readiness失敗）などの配信ゲート失敗時は `status: "skipped"` を許容する

#### FR-04-2 通知抑制ルール

- 返信が `HEARTBEAT_OK` のみ、または端に含まれる短文ACKの場合は通知を抑制
- `ackMaxChars`（既定300）以下の残文は無通知扱い
- `HEARTBEAT_OK` が文中中央にある場合は通常テキスト扱い
- `ok-token` / `ok-empty` の抑制は `HeartbeatRunResult.status: "ran"` を維持しつつ、イベントログ側に `status: "ok-token"` / `status: "ok-empty"` を記録する

#### FR-04-3 スキップ条件

- `HEARTBEAT.md` が存在し、かつ実質空（見出し/空行のみ）の場合は実行スキップ
- Heartbeat対象の実行レーン（MVP既定: `CommandLane.Main`）に未処理実行がある場合は `requests-in-flight` としてスキップし、1秒後に再試行する（OpenClaw既定に準拠）。
- グループセッションへのHeartbeatはMVPでは無効（ノイズ抑制）
- `activeHours` を設定した場合、時間外は `quiet-hours` としてスキップ

#### FR-04-4 可視性設定

- `showOk` / `showAlerts` / `useIndicator` を持つ
- 3つすべて `false` の場合はHeartbeat自体を実行しない
- 既定は `showOk=false`, `showAlerts=true`, `useIndicator=true`

#### FR-04-5 Heartbeatコスト最適化（推奨）

- Heartbeat実行は通常対話と別モデルを指定可能にする（例: 軽量モデル）
- モデル未指定時は通常対話モデルを利用する
- 実行結果ログに `modelId` を残し、運用時にコスト分析可能にする

#### FR-04-6 重複通知抑制（必須）

- 直近送達したHeartbeat本文と同一の本文が再生成された場合、`duplicate` として送信を抑制する
- 抑制ウィンドウ既定値は24時間（将来設定化）
- `duplicate` 抑制時も `status: "ran"` を維持する

受け入れ条件:
- AC-07: `HEARTBEAT_OK`/ACK短文時は通知抑制され、`HeartbeatRunResult.status: "ran"` と `HeartbeatEventPayload.status: "ok-token" | "ok-empty"` が記録され、`GET /api/heartbeat/last` で確認できる。
- AC-08: 注意喚起テキストはユーザーに通知される。
- AC-09: `HEARTBEAT.md` 実質空ではモデル呼び出しなしで `status: "skipped"` になる。
- AC-18: **アラート配信前**の配信チャネルreadinessチェックが失敗した場合、`HeartbeatRunResult.status: "skipped"` と `HeartbeatEventPayload.status: "skipped"` が記録される（`ok-token`/`ok-empty` の可視化判定側readiness失敗は `ran` + `ok-*` を維持）。
- AC-16: 24時間以内に同一本文のHeartbeat通知が再生成された場合は `HeartbeatEventPayload.status: "skipped"` かつ `reason: "duplicate"` で記録され、`HeartbeatRunResult.status: "ran"` を維持する。
- AC-22: `requests-in-flight` 発生時は `status: "skipped"` で記録され、1秒後再試行が行われる。

### FR-05 assistant-ui チャットUI

- `assistant-ui` を用いて以下を提供:
  - ユーザー入力
  - AIストリーミング応答表示
  - システムイベント（Heartbeat実行/通知）表示
- 最小限の画面:
  - 会話ビュー（時系列）
  - 接続状態/実行状態インジケータ
- 接続方式は **カスタム Runtime + SSE** をMVP標準とする
  - `POST /api/chat/messages` で run を作成
  - `GET /api/chat/runs/:runId/stream` で `run_started` / `text_delta` / `text_end` / `run_end` / `error` を購読
  - UIの終端判定は `run_end` のみを正とする（`error` は診断表示用）。
  - SSE契約としては `tool_call` / `tool_result` も流れるが、MVP UI では表示必須としない（受信して無視可）。
- Heartbeat可視化の取得方式はMVPで固定する
  - `GET /api/heartbeat/last` を `3s` 間隔でポーリングし、`main` セッションの最新状態をUI表示する（OpenClaw UI debug poll準拠）
  - `system_event` の履歴表示は `GET /api/chat/sessions/:sessionId/messages` の結果を利用する（専用WebSocketは設けない）

受け入れ条件:
- AC-14: `assistant-ui` でストリーミング表示され、`run_end` 到着で完了確定して履歴へ保存され、`main` セッションのHeartbeat状態は `GET /api/heartbeat/last` のポーリングで更新表示される。

### FR-06 セッショントランスクリプト管理（OpenClaw準拠MVP）

- チャットの入出力と主要イベントを、セッション単位のJSONLに追記保存する
- トランスクリプト用途:
  1. 会話履歴表示（UI）
  2. 実行再開時の文脈復元
  3. 監査ログ
- AI入力は「Slackイベント窓（FR-02）」に加えて「セッショントランスクリプトの直近窓」も取り込む
- 将来の索引化を見据え、1行ごとに `sessionId`, `sessionKey`, `runId`, `type`, `ts` を必須とする
- `sessionId` 指定の**実行要求**は、内部で対応する `sessionKey` を解決してキュー制御に使う
- `GET /api/chat/sessions/:sessionId/messages` は表示/履歴取得専用であり、キュー制御には関与しない

受け入れ条件:
- AC-10: セッショントランスクリプトがJSONLに追記保存される。
- AC-17: AI実行時にセッショントランスクリプトの直近窓が入力へ取り込まれ、再開時の文脈復元に利用される。

### FR-07 ファイルベース簡易メモリ（MVP）

- メモリファイル:
  - 長期: `MEMORY.md`
  - 日次: `memory/YYYY-MM-DD.md`
- 読み込み:
  - 通常対話/Heartbeatともに `MEMORY.md` と当日・前日の日次メモを参照する
- 書き込み:
  - ユーザーの明示指示（例: 「覚えておいて」）時のみメモリ更新を行う
  - Heartbeat実行時（`isHeartbeat=true`）は `memory_write` ツールを無効化する
  - AIの自動判断による無条件書き込みはMVPでは行わない
- ベクトル検索やSQLite索引は使わず、ファイル読み書きのみを実装する

受け入れ条件:
- AC-11: 明示指示時にのみメモリへ保存され次回ターンで再利用され、`isHeartbeat=true` 実行ではメモリ書き込みが発生しない。
- AC-15: 通常対話とHeartbeatの両方で `MEMORY.md` と当日・前日メモが入力コンテキストへ取り込まれる。

### FR-08 ペルソナ設定（SOUL.md）

- ワークスペースに `SOUL.md` を置き、応答言語・トーン・優先度判断方針を記述可能にする
- `SOUL.md` はシステムプロンプト組み立て時に読み込み、通常対話とHeartbeatの両方へ適用する
- ファイル未存在時はデフォルト方針（日本語・簡潔）で動作する

受け入れ条件:
- AC-12: `SOUL.md` の内容が通常対話/Heartbeatの応答方針へ反映される。

### FR-09 SystemEventQueue（MVP）

- `sessionKey` 単位のエフェメラルFIFOキューを持つ
- `sessionId` は表示/永続ID、`sessionKey` は実行ルーティングIDとして使い分ける
- enqueue APIは `sessionKey` を必須入力とし、キュー要素の最小必須項目は `text` / `ts(epoch ms)` とする（OpenClaw準拠）
- `contextKey` は enqueue オプションとして受け取る。`SystemEvent` 本体には保存せず、`SessionQueue` 側の補助状態（`lastContextKey`）としてのみ保持する。
- `sessionId` は未解決でも enqueue 可能にする
- Slackイベント由来の要約テキストを enqueue し、次回ターンのプロンプト先頭へ注入する
- 注入後はdrainして二重注入を防ぐ
- 連続重複（同一 `text`）はenqueueしない
- `contextKey` は「同一文脈かどうか」の判定補助として enqueue 判定側でのみ利用し、キュー層での一律重複排除キーにはしない
- キュー上限を設定し（例: 20件）、超過時は古いイベントから破棄する

受け入れ条件:
- AC-13: SystemEventQueueが `sessionKey` ごとに分離され、注入後drainされる。

## 5. インターフェース要件（MVP案）

### 5.1 バックエンドAPI

1. `POST /api/chat/messages`
- 入力: `{ sessionId?, sessionKey?, text, clientMessageId }`
- 解決規則: `§2.3` の優先順を適用し、実行キュー投入は必ず `sessionKey` で行う
- `clientMessageId` は冪等キーとして必須。`(sessionKey, clientMessageId)` が同一であれば、冪等TTL（既定300秒）内は既存 `runId` を返し新規キュー投入しない。
- 出力: 受理応答（`{ runId, sessionId, sessionKey, accepted: true, deduplicated: boolean }`）

2. `GET /api/chat/runs/:runId/stream`
- 入力: `runId`
- 出力: SSEストリーム（`run_started` / `text_delta` / `tool_call` / `tool_result` / `text_end` / `run_end` / `error`）

3. `GET /api/chat/sessions/:sessionId/messages`
- 入力: `sessionId`（表示・履歴取得専用）
- 出力: メッセージ履歴（表示用）

4. `POST /api/heartbeat/run`
- 入力: `{ mode: "now" | "scheduled" }`
- 出力: 実行結果（`HeartbeatRunResult`）

5. `GET /api/heartbeat/last`
- 入力: なし
- 出力: `main` セッションの直近Heartbeatイベント（`HeartbeatEventPayload | null`）
- UI契約: `assistant-ui` 側は `3s` 間隔ポーリングで利用する（MVP固定、OpenClaw UI debug poll準拠）
- 備考: `sessionKey` 指定での取得はMVP対象外（将来拡張）

注記:
- `chat.abort` 相当の実行中断APIはMVPでは提供しない（`§2.2`）。

### 5.2 内部I/O契約

1. Event Store（既存）
- ファイル: `data/YYYY/MM/DD/slack/events.jsonl`
- 1行1イベント、追記専用

2. Heartbeat設定
- 設定キー例:
  - `heartbeat.every`
  - `heartbeat.prompt`
  - `heartbeat.ackMaxChars`
  - `heartbeat.showOk`
  - `heartbeat.showAlerts`
  - `heartbeat.useIndicator`

3. Heartbeat指示ファイル
- `HEARTBEAT.md` をワークスペース内の規定位置に配置

4. ペルソナファイル
- `SOUL.md` をワークスペース内の規定位置に配置

5. メモリファイル
- `MEMORY.md`
- `memory/YYYY-MM-DD.md`

6. セッショントランスクリプト
- ファイル: `<dataDir>/_sessions/<sessionId>.jsonl`
- `user_message` / `assistant_message` / `tool_call` / `tool_result` / `system_event` を追記保存
- 各行は `sessionId`, `sessionKey`, `runId`, `type`, `ts` を必須とする

7. SystemEventQueue（エフェメラル）
- `sessionKey` 単位のインメモリFIFO
- enqueue入力は `sessionKey` 必須、キュー格納要素は `text` / `ts(epoch ms)`（OpenClaw準拠）
- `contextKey` は enqueue オプションとして受け取り、`SessionQueue` の補助状態としてのみ保持して連続重複抑制や文脈変化判定に利用する（`SystemEvent` には格納しない）
- 永続化しない（プロセス再起動で消える）

## 6. データモデル要件（MVP案）

### 6.1 Slackイベント（既存継続）

- `schema: "adjutant.event.v1.1"`
- 必須: `uid`, `source`, `kind`, `ts`
- 推奨: `detail.slack`（channel, text, thread情報）

### 6.2 AI入力コンテキスト（新規）

```ts
type AiContextWindow = {
  schema: "adjutant.ai.context.v1";
  builtAt: string; // ISO8601
  sessionId: string;
  sessionKey: string;
  range: {
    from: string;
    to: string;
  };
  events: Array<{
    uid: string;
    ts: string;
    kind: string;
    actor?: string;
    text?: string;
    channelId?: string;
    threadTs?: string;
  }>;
  systemEvents: Array<{
    ts: number; // epoch ms
    text: string;
  }>;
  memory: {
    longTerm: string | null; // MEMORY.md
    daily: string | null; // memory/today
    yesterday: string | null; // memory/yesterday
  };
  truncated: boolean;
};
```

### 6.3 Heartbeat実行結果（新規）

```ts
type HeartbeatRunResult =
  | { status: "ran"; durationMs: number }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

type HeartbeatRunRecord = {
  schema: "adjutant.heartbeat.result.v1";
  runAt: string; // ISO8601
  sessionId?: string;
  sessionKey?: string;
  result: HeartbeatRunResult;
  modelId?: string;
  preview?: string;
};
```

### 6.4 Heartbeatイベントログ（新規）

```ts
type HeartbeatEventPayload = {
  ts: number; // epoch ms
  status: "sent" | "ok-empty" | "ok-token" | "skipped" | "failed";
  reason?: string;
  to?: string;
  channel?: string;
  accountId?: string;
  preview?: string;
  durationMs?: number;
  hasMedia?: boolean;
  silent?: boolean;
  indicatorType?: "ok" | "alert" | "error";
};
```

### 6.5 セッショントランスクリプトイベント（新規）

```ts
type SessionTranscriptEvent = {
  schema: "adjutant.session.event.v1";
  sessionId: string;
  sessionKey: string;
  runId: string;
  ts: string; // ISO8601
  type: "user_message" | "assistant_message" | "tool_call" | "tool_result" | "system_event";
  payload: Record<string, unknown>;
};
```

### 6.6 内部実行状態ログ（新規）

- `AgentRunStatus` は可観測性向上のための内部ログ型として扱う。
- 外部公開の run 状態追跡APIはMVP対象外（`§2.2`）。

```ts
type AgentRunStatus = {
  schema: "adjutant.agent.run-status.v1";
  sessionId: string;
  sessionKey: string;
  runId: string;
  status: "queued" | "running" | "completed" | "failed";
  reason?: string;
  updatedAt: string; // ISO8601
};
```

### 6.7 SystemEvent（新規）

```ts
type SystemEvent = {
  text: string;
  ts: number; // epoch ms（OpenClaw準拠）
};

type SystemEventEnqueueOptions = {
  sessionKey: string; // 必須（ルーティングキー）
  contextKey?: string;
};
```

### 6.8 ストリーミングイベント（新規）

```ts
// seq は公開SSEの連番。runIdごとに 1..N で再採番する。
type StreamEvent =
  | { type: "run_started"; runId: string; sessionId: string; sessionKey: string; seq: number }
  | { type: "text_delta"; runId: string; delta: string; seq: number }
  | {
      type: "tool_call";
      runId: string;
      toolCallId: string;
      name: string;
      params: unknown;
      seq: number;
    }
  | {
      type: "tool_result";
      runId: string;
      toolCallId: string;
      name: string;
      isError: boolean;
      result: unknown;
      seq: number;
    }
  | { type: "text_end"; runId: string; text: string; seq: number }
  | { type: "run_end"; runId: string; status: "completed" | "failed"; seq: number }
  | { type: "error"; runId: string; message: string; seq: number };
```

## 7. 非機能要件（MVP）

1. 可用性
- Slack切断時に既存再接続ロジックで自動復帰する

2. 性能
- 通常チャット応答の初回トークン開始を5秒以内目標（ローカル開発環境）

3. 監査性
- Heartbeat実行ログと結果ステータスを記録し、あとから追跡可能にする

4. セキュリティ
- Slackトークンや個人情報をUIログに平文表示しない
- JSONLの外部共有前にマスキング手順を用意する
- APIサーバーは既定で `127.0.0.1` にのみバインドし、外部公開を前提にしない
- 副作用ツールを有効化する場合は、実行先を制限したサンドボックス（例: Docker）を推奨する

5. 順序保証
- 同一セッション内イベントは、保存順とUI表示順が一致すること
- followup キュー投入時も先着順を維持すること

6. 可観測性
- セッション単位で `queued/running/completed/failed` を内部ログとして記録する（外部API公開はMVP対象外）
- Heartbeat結果、再試行発生、SystemEventQueueのdrain件数をイベントログに残す

## 8. 受け入れ条件一覧（トレーサビリティ）

受け入れ条件の詳細は `§4` 各FR直下を正とし、本節は追跡用の一覧とする。

| AC | 対応FR | 検証観点 |
|---|---|---|
| AC-01 | FR-01 | Slackイベントが `adjutant.event.v1.1` でJSONL追記される |
| AC-02 | FR-02 | AI応答時にJSONL由来コンテキストが入力される |
| AC-03 | FR-03 | OpenClaw準拠のSDK実行手順（lock→open→create→subscribe→dispose）を満たす |
| AC-04 | FR-03 | 同一 `sessionKey` で同時実行が発生しない |
| AC-05 | FR-03 | 異なる `sessionKey` 間でコンテキストが混線しない |
| AC-06 | FR-03 | 一時失敗時の1回再試行/切り詰め再試行が機能する |
| AC-07 | FR-04 | `HEARTBEAT_OK` 抑制時は `HeartbeatRunResult.status: "ran"` と `HeartbeatEventPayload.status` で記録され、`GET /api/heartbeat/last` で確認できる |
| AC-08 | FR-04 | Heartbeatアラートが通知される |
| AC-09 | FR-04 | `HEARTBEAT.md` 実質空で `status: "skipped"` になる |
| AC-10 | FR-06 | セッショントランスクリプトが `sessionId/sessionKey/runId` 付きで永続化される |
| AC-11 | FR-07 | 明示指示時のみメモリ書き込みされ、Heartbeat実行時は書き込まれない |
| AC-12 | FR-08 | `SOUL.md` が通常対話/Heartbeatの応答方針に反映される |
| AC-13 | FR-02/FR-09 | SystemEventQueueが `sessionKey` ごとに注入・drainされる |
| AC-14 | FR-05 | `assistant-ui` でストリーミング表示され、`run_end` で完了確定して履歴保存され、`main` セッションのHeartbeat状態が `GET /api/heartbeat/last` ポーリングで表示更新される |
| AC-15 | FR-07 | 通常対話/Heartbeatの両方で `MEMORY.md` と当日・前日メモが入力コンテキストへ取り込まれる |
| AC-16 | FR-04 | 24時間以内の同一Heartbeat本文は `reason: "duplicate"` で抑制され、`HeartbeatRunResult.status: "ran"` を維持する |
| AC-17 | FR-06 | AI実行時にセッショントランスクリプト直近窓が入力へ取り込まれ、再開時の文脈復元に利用される |
| AC-18 | FR-04 | アラート配信前の配信チャネルreadiness失敗時は `HeartbeatRunResult.status: "skipped"` と `HeartbeatEventPayload.status: "skipped"` が記録される |
| AC-19 | FR-03 | 致命的エラー時は `error` を診断用に送出しつつ、最終的に `run_end(status: "failed")` で終端してUI終端判定を一意にできる（`run_end` は `runId` ごとに1回のみ） |
| AC-20 | FR-04 | Heartbeat実行時の送信Body末尾に `Current time: <formattedTime> (<userTimezone>)` 行が注入され、同一実行で重複挿入されない |
| AC-21 | FR-03 | 同一 `sessionKey` + `clientMessageId` 再送時は冪等処理され、既存 `runId` を返して重複runを作らない |
| AC-22 | FR-04 | `requests-in-flight` 時は `status: "skipped"` で記録され、1秒後再試行が行われる |

## 9. 既知の制約

1. JSONL直接読み込みのため、大量データ時は読み込みコストが増える
2. SlackのDOM/CDP仕様変更に追従が必要
3. Heartbeatは誤検知で不要通知を出す可能性がある
4. assistant-ui導入初期は最低限の状態管理のみで、高度なUXは次フェーズ
5. セッションメモリのSQLite索引化はMVP対象外のため、長期想起は限定的
6. 実行中ランへの割り込み（steer）は未対応で、追加入力は待ち行列処理のみ
7. Heartbeatの回転実行（overdueタスク優先）はMVP対象外で、実行は固定間隔ベース

## 10. 次フェーズ候補（MVP後）

1. JSONL索引化（SQLiteまたは軽量インデックス）でコンテキスト抽出高速化
2. 重要イベント分類器（ルール + LLM）によるHeartbeat誤通知削減
3. マルチチャネル（GitHub/Gitローカル）統合と横断要約
4. ユーザーごとの通知ポリシー/静穏時間設定
5. Cron/Webhook/PubSub 連携によるマルチトリガー起動
6. モデルカスケード（軽量モデル判定 + 上位モデル昇格）の本格実装
7. Hook拡張点（`before_agent_start` / `agent_end`）の導入
8. 実行中ランへのsteer、action承認API、run状態追跡APIの導入
