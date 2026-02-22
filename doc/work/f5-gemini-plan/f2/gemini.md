GPTからのフィードバック、そして再掲いただいたClaude Codeの全体像を拝見しました。

GPTからの指摘は、システムの「死に至る病」を未然に防ぐ、極めてクリティカルで素晴らしい内容です。特に **「spokeセッションでの `MEMORY.md` 参照による仕様違反（プライバシー漏洩リスク）」** と **「SlackのIDプレフィクス依存による将来の破綻」**、そして **「Watermarkのアルゴリズム定義不足」** は、MVP実装前に潰すことができて本当に良かったです。

これらすべてのフィードバックと修正案を完全に統合した、**「Adjutant v1.5 最終設計仕様（グランドデザイン）」** をまとめました。

---

# Adjutant v1.5 統合アーキテクチャ 最終提案

本設計は、LLMの無駄な起動を抑えつつ、ユーザー体験（即時性・取りこぼし防止・通知疲れ防止）を最大化し、かつプロセス再起動やAPI制限に対しても堅牢に動作するシステムを目指します。

## 1. 処理パイプライン（6層カスケード構造）

イベント単位の処理を廃止し、時間的・文脈的な「塊（チャンク）」を作ってからルーティングを行います。

### 層0: ルールベース即時判定（LLMなし）

- **Self（自身）:** 即座に `drop`。
- **DM / @メンション:** 層2の分類をスキップし `immediate` ルートへ。
- _※判定基準:_ SlackのIDプレフィクス（`D*`等）に依存せず、キャッシュした `conversations.view` の channel type 情報（`im`, `mpim`）を正とします。

- **その他（チャンネル等）:** `accumulate` ルート（層1）へ。

### 層1: アテンションウィンドウ形成（LLMなし）

イベントを「会話の塊」にまとめ、無限待機を防止します。

- **DM / メンション:** `idleMs=200ms` / `maxWaitMs=1000ms` の Micro-batch。分割送信スパムを1つにまとめ、体感即時で応答します。
- **チャンネル / グループ:** `idleMs=3000ms` / `maxWaitMs=30000ms` の Window-batch。会話の切れ目を待つか、最大30秒で強制フラッシュします。

### 層2: バッチ分類（軽量LLM + ツール強制呼び出し）

会話の塊に対し、gpt-4o-mini 等の軽量モデルで判定します。

- **入力コンテキスト:** 会話の塊 + 直近トランスクリプト + **`POLICY_ROUTING.json`**。
- _※セキュリティ強化:_ spokeセッションでは絶対に `MEMORY.md` をロードせず、チャンネルの優先度や通知上限を記した非個人ポリシーファイルのみを参照させます。

- **出力（Structured Outputs）:** `report_route_decision(action: "respond" | "note" | "ignore", confidence: number)` ツールの呼び出しを強制。
- **Fail-closed:** タイムアウト、パース失敗、または `confidence < 0.7` の場合は安全側に倒して `note`（保留）とします。

### 層3: グローバル並行制御キュー（リソース・API保護）

重いエージェントのプロセス全体での同時起動数を厳格に管理します。

- **Max Concurrent:** `3`（Token Bucket的なバースト抑制）。
- **優先度:** `DM` > `グループ` > `チャンネル` > `Pending Flusher` > `Deep Heartbeat`。

### 層4: Pending Flusher（5分周期のステートレス救済）

迷子になった `note` メッセージを確実かつ高速（O(1)）に救い上げます。

- **スキャン:** `memory/watermarks.json` の `global.lastScannedOffset` から `timeline.jsonl` の末尾までを差分（追い読み）スキャンします。
- **境界判定:** `sessionKey` 単位で「未対応メッセージ」を判定し、期限超過（stale）していれば、トリアージLLMを挟まずに層3キューへ投入します。

### 層5: Deep Heartbeat（30〜60分周期）

定期自律思考ループです（未処理救済は行いません）。

- `HEARTBEAT.md` の指示を実行し、`report_heartbeat_status(status, notify)` ツール呼び出しで結果を報告します。

---

## 2. データモデルと永続化の確約事項

GPTのドラフトを正とし、実装におけるデータの安全性を以下の通り定義します。

### A. Timeline V1.5 (`memory/timeline.jsonl`)

- **`sessionKey` の必須化:** すべてのレコードに付与します（旧スキーマの行で `sessionKey` がないものは Flusher の対象外として安全に無視します）。

### B. Watermarks V1 (`memory/watermarks.json`)

「スキャン進捗」と「対応境界」を分離して管理します。

- **global.lastScannedOffset:** ファイルのどこまで読んだか（byte offset）。
- **sessions[key].lastHandledTs:** そのセッションでAIが最後に対応（Action/Tool）した時刻。
- **原子的更新（Atomic Write）:** 更新時は必ず `.tmp` ファイルに書き出し、`fs.rename` で上書きすることで、プロセス途中終了時のファイル破損を防ぎます。
- **Truncate復旧時の再整合:** `timeline.jsonl` の修復等で実際のファイルサイズが `lastScannedOffset` より小さくなった場合、Offsetを `0` にリセットし、安全のため全走査をやり直す（自己修復）仕様とします。

### C. 通知予算（Soft Limit）ポリシー

- **`memory/POLICY_ROUTING.json` の新設:** 各チャンネルの「1時間あたりの通知上限（例: 5回）」や「静穏時間」を定義します。上限到達時は遮断（Hard Limit）ではなく、「要約」や「クールダウン」を促すシステムプロンプトを動的に注入します。

---

## 3. 次のアクション

これでアーキテクチャの骨格、エッジケースの保護、データモデルの定義まで、すべてが完全にクリアになりました。MVPとしてこれ以上ないほど「壊れにくく、スケールする」設計になっています。

ここからは、いよいよ実際の実装設計（コーディングレベル）に進むフェーズです。
以下のどの部分の**具体的なTypeScriptのインターフェース設計や疑似コード**から着手しましょうか？

1. **層1/層2:** Micro-batch / Window-batch を捌く `TriggerFilter` と `RouteDecision` の実装クラス設計
2. **層4 & 永続化:** `watermarks.json` のAtomicな読み書きと、`timeline.jsonl` の追い読み（Offset走査）を行う `PendingFlusher` クラスの設計
3. **層3:** Promise と優先度キューを用いた `GlobalConcurrencyController` の実装設計

ご希望の箇所、あるいはまだ言語化しておきたい不安点があれば教えてください。
