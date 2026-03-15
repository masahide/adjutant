# 収集ランタイム仕様

## 1. 目的

この文書は、Adjutant における Slack 収集ランタイムの責務、処理フロー、補完処理、正規化前後の境界を定義する。

## 2. スコープ

### 含むもの

- CDP 接続
- Slack API / WebSocket / response hook の収集
- DOM capture
- イベント補完
- 正規化して保存層へ渡すまでの前段処理

### 含まないもの

- 保存詳細
  - 将来 `storage.md`
- データモデルの完全定義
  - [data-model.md](/Users/USER/masahide/git/adjutant/doc/spec/data-model.md)
- ACP / control-plane のプロセス連携詳細
  - 将来 `acp-architecture.md`

## 3. 責務

- Slack Desktop の CDP endpoint へ接続する
- 収集対象イベントを抽出する
- 本文、チャンネル名、ユーザー名などを補完する
- 必要に応じて DOM から追加情報を取得する
- 正規化済みイベントを保存層へ渡す

## 4. 主要コンポーネント

- `connectToSlackPage`
- `SlackAdapter`
- `SlackIngestor`
- `DomCaptureService`
- `JsonlWriter`
- `SlackNameCacheRepository`
- `DebugUiServer`（legacy 単体収集時の任意 UI）

## 5. 代表フロー

### 5.1 起動と再接続

- legacy 単体収集モードでは `src/index.ts` を起点に CDP 収集を開始する
- ACP 標準構成では `src/index.ts` は control-plane のエントリポイントとして利用し、収集は `collector-slack` 子プロセスへ分離する
- 起動時に既存 JSONL を走査し、破損末尾が見つかったファイルは当該オフセットまで truncate してから収集を開始する
  - `listJsonlFiles` -> `recoverJsonlFiles`
- `resolveEndpoint()` は以下優先順位で接続先を解決する
  1. `CDP_ENDPOINT_FILE`
     - 既定 `.adjutant/cdp-endpoint.json`
  2. `CDP_HOST` / `CDP_PORT`
  3. 既定値 `127.0.0.1:9222`
- セッション切断時は再接続ループへ移行する
  - リトライ待機は `computeFullJitterDelayMs()` による指数バックオフ + フルジッタ
  - 基本式は `maxDelay = min(10000, 1000 * 2^(attempt - 1))`
  - 実際の待機時間は `delay = floor(random() * maxDelay)`
  - `attempt` は最小 1
- `SIGINT` / `SIGTERM` では adapter / client / debug UI を停止して終了する

### 5.2 Fetch interception

`Fetch.enable()` は以下 URL を Request ステージで監視する。

- `*://*.slack.com/api/chat.postMessage*`
- `*://*.slack.com/api/reactions.*`

処理内容:

- POST body を解析して `normalizeSlackMessage` / `normalizeSlackReaction` へ渡す
- `reactions.*` では DOM キャプチャ結果が取得できれば `message_text` を補完する

### 5.3 WebSocket frame

`webSocketFrameReceived` で受信した payload を解釈し、次を実施する。

- message 系イベントから本文キャッシュ更新
- 通知候補を抽出して `kind=notification` イベントを生成

### 5.4 Response hook

`responseReceived` で次を実施する。

- `Network.getResponseBody` により API 応答の本文情報を補完する
- `conversations.view` 応答からチャンネル名キャッシュを更新する
- `/cache/{team}/users/list` 応答からユーザー名キャッシュを更新する

### 5.5 DOM capture

- `DomCaptureService` は `Runtime.evaluate` で候補 DOM を探索する
- タイムスタンプ一致候補を複数 selector で探索し、本文 / チャンネル情報を抽出する
- リトライ遅延は `0ms, 100ms, 200ms, 300ms`
- `ADJUTANT_DISABLE_DOM_CAPTURE=1|true` で無効化できる

## 6. 契約

- endpoint 解決順序
- hook 対象
- retry / backoff
- 去重方針

### 6.1 接続契約

- CDP endpoint は `resolveEndpoint()` の優先順位に従って解決する
- 切断時は full jitter backoff で再接続する
- control-plane 標準構成では収集を別プロセスへ分離する

### 6.2 収集契約

- `chat.postMessage` と `reactions.*` は request body から正規化候補を作る
- WebSocket frame は通知候補と本文キャッシュ更新に使う
- response hook は response body 補完と名称キャッシュ更新に使う

### 6.3 補完契約

- DOM capture は補助的な本文補完手段であり、必須経路ではない
- メッセージ本文や名称情報は、API / WebSocket / DOM の複数経路で補完されうる

### 6.4 去重契約

- `SlackAdapter` は同一 `uid` をメモリ上で去重する
- 同一プロセス内での重複書き込みを防ぐが、正本ファイル側の再構築責務とは分離する

## 7. 実装対応

- 旧統合仕様書にあった収集・Slack・DOM capture の記述を、現行実装ベースで再構成している
- 現行標準構成では `collector-slack` 子プロセスが収集責務を持つ
- control-plane との境界や ACP 分離の詳細は別文書へ分離する

## 8. 既知の制約

- `/api/reactions.*` の送信を契機に動くため、他ユーザー由来の受信通知だけでは DOM capture が発火しない
- メッセージが可視 DOM に存在しない場合、本文補完できない
- 本文補完や通知候補抽出は Slack 側 payload の揺れに影響を受ける
- 本文書は legacy / 単体収集ランタイムの参照仕様を含むため、ACP 標準構成の詳細とは別に読む必要がある

## 9. 関連文書

- [概要](/Users/USER/masahide/git/adjutant/doc/spec/overview.md)
- [全体像](/Users/USER/masahide/git/adjutant/doc/spec/system-overview.md)
- [詳細仕様インデックス](/Users/USER/masahide/git/adjutant/doc/spec/detail-index.md)
