# GPTからのフィードバック

要約

- **最優先の修正**は、`memory/timeline.jsonl` に **`sessionKey` を必須化**し、救済判定の「処理済み境界（watermark）」を **`sessionKey` 単位**にすることです。現状は未対応が永久に隠れ得ます。
- **会話の単位を「イベント」→「会話塊（アテンションウィンドウ）」**に変える方針は、Gemini/Claude Code ともに妥当で、ここがコストと誤介入を最も下げます。
- LLMの安定運用は **構造化出力**が鍵ですが、SDK制約があるなら **必須ツール呼び出し**で代替するのが現実解です。([OpenAI Developers][1])
- 残る設計論点は **「max-wait（最大待機）」**と **グローバル並行制御**。ここを落とすと、無反応や瞬間スパイクで破綻します。([docs-lodash.com][2])

---

## 収束点 — 仕様として確定してよいこと

- 会話の切れ目を待って **会話塊で一回だけ分類**（分類前にバッファリング）
- `memory/timeline.jsonl` に **`sessionKey` を必須化**
- 「未処理救済」と「定期巡回（HEARTBEAT.md）」は **責務分離**
- `HEARTBEAT_OK` などの **文字列マッチ運用は廃止**し、構造化（ただしSDK制約ならツール呼び出しで代替）([OpenAI Developers][1])

ここまでは、議論がほぼ収束しています。

---

## Geminiフィードバック — 疑問と反証

### Gemini案「安全側は過剰介入」への反証

**チャンネル（`C*`）での安全側は “過剰介入” ではなく “保留（fail-closed）” が基本**が良いです。
理由は、通知や割り込みが増えるとユーザーが無効化・離脱する傾向が強く、過剰介入のコストが高いからです（通知疲れ・アラート疲れ）。([ロイターズ研究所][3])
一方で **DM（`D*`）は過剰介入寄り**でも許容されやすい、という Claude Code の整理は妥当です。

### Gemini案「DMは完全バイパス（遅延0ms）」への反証

「サーバー落ちた！」に数秒待ちを入れるべきではない、は正しいです。
ただし **“完全0ms” だと分割送信で重エージェントが連発**し得るので、DM/メンションは **micro-batch（例 150–300ms）**を入れるのが実務的です（体感即時を保ちつつ結合）。
さらに **max-wait（最大待機）**を入れないと、会話が続く限りフラッシュされない問題が起きます。これは一般的な debounce にも `maxWait` が用意される理由です。([docs-lodash.com][2])

### Gemini案「resolved_by_human を確定判定」への反証

「他者返信があるなら解決済み」という確定判定は危険です（暗黙解決・文化差・質問が残る、が普通）。
この信号は **確定ではなく抑制バイアス（urgency低下、due延長、notify抑制）**として扱うのが安全です。

### Gemini案「dueAt を timeline に入れて救済」について

方向性は良いですが、**timeline 本体に `dueAt` を大量に混ぜると走査が重くなりがち**です。MVPでは「5分 Flusher」で十分という Claude Code の主張も成立します。
ただし「due-based を捨てる」ではなく、**差分を別ファイルに切り出す**と実装難易度を抑えられます（後述で回答）。

---

## Claude Codeフィードバック — 疑問と補強

### Claude Code案「immediate/pending の2値でMVP十分」への補強

2値でも良いです。**ただし条件付き**で、次の2点を入れないと破綻します。

- **max-wait**（例: 30秒）で強制フラッシュ
- **グローバル並行制御**で同時起動スパイクを抑制

この2つが入るなら、`soon/batch` を先送りしても UX は大きく崩れにくい、という見立てに同意します。

### Claude Code案「Pending Flusher でトリアージLLMは要るか」への回答

MVPでは **不要**でよいです。
「未対応だが対応不要」の頻度が高いかは、実データ依存なので **計測してから入れる**のが合理的です。
ただし「不要介入が多い」と分かったら、トリアージLLMではなく **Route LLM と同じ“会話塊分類器”を再利用**してコストを抑えるのが筋です（LLMの種類を増やさない）。

---

## Claude Codeから GPT への質問 — 回答

### Claude Code宛の回答「due-based rescue は JSONL スキャンと同じでは」

**結論**: *timeline 本体を毎回スキャンする*なら差が小さいです。差別化には **“スキャン対象を小さくする”**工夫が要ります。
MVPでもできる最小案は次のどちらかです（SQLite不要）。

- `memory/pending-index.jsonl` を新設し、`{uid, sessionKey, dueAt, state}` を **別JSONLに追記**
  - Flusherは **indexだけ**を見る（timeline全走査を避ける）

- もしくは `sessionKey` ごとに `memory/pending/<sessionKey>.jsonl` を作って分割
  - Flusherは “今dueなセッション” だけ読む

この形なら「due-based」の価値（期限順・対象縮小）が出ます。SQLite移行（WHERE `dueAt <= now()`）は将来最適化で良いです。

### Claude Code宛の回答「通知予算化はどこに置くべきか」

賛成です。**ルーティングではなく“通知フィルター”層**に置くのがきれいです。
また hard limit ではなく **soft limit（抑制・要約・クールダウン）**が安全です。通知疲れで無効化・離脱が起きうるため、乱発を避ける設計は価値があります。([ロイターズ研究所][3])

---

## LLM利用箇所の統合案 v1.5 — 結論の要点

### 層0 ルール即時 — LLMなし

- self → `drop`
- DM / @メンション → `immediate`
- それ以外 → `accumulate`

### 層1 アテンションウィンドウ形成 — LLMなし

- `idleMs`（沈黙で切れ目） + `maxWaitMs`（最大待機）で **会話塊**を確定
- `maxWait` は、debounce が無限に遅延しないための典型オプションです。([docs-lodash.com][2])

### 層2 会話塊分類 — 軽量LLM

- 入力: 会話塊 + 直近トランスクリプト（5〜10件）+ spoke向け通知ポリシー
- 出力: `action: respond | note | ignore` + `confidence`
- **構造化**: SDKで strict JSON Schema が難しいなら「必須ツール呼び出し」で代替（例: `report_route_decision(...)`）。Structured Outputs はスキーマ一致を強化できるため、可能なら採用価値が高いです。([OpenAI Developers][1])

### 層3 グローバル並行制御 — LLMなし

- `maxConcurrentAgentRuns`（例: 3）
- 優先度: DM > group > channel > flusher > deep heartbeat
- バースト抑制は token bucket のような考え方が分かりやすい（短期バースト許容＋平均抑制）。([System Overflow][4])

### 層4 Pending Flusher — LLMなし

- 5分周期で **`sessionKey` 単位 watermark**から未処理を検出し、層3へ投入
- ここで初めて “救済起動” する（Deep Heartbeatとは分離）

### 層5 Deep Heartbeat — 重LLM

- `HEARTBEAT.md` が実質空なら呼ばない
- 結果は `report_heartbeat_status(...)` のツール呼び出しで返す（文字列マッチ禁止）

---

## 注記

- 会話塊 — 「一定時間内に連続して到着したイベント群」。ユーザーが期待する“ひとまとまり”に近い単位。
- 処理済み境界（watermark）— 「この `sessionKey` はここまで対応済み」という境界。グローバルにすると取りこぼします。
- 構造化出力 — strict JSON Schemaが無理なら、ツール呼び出しで **機械的に分岐できる出力**を強制する。([OpenAI][5])

---

## 見解

- 今回の議論で一番大きい収穫は、「**イベント単位の判定をやめる**」「**sessionKey境界を正しくする**」に収束したことです。ここを直せば、Route LLM の細かい最適化（kNN等）を後回しにしても、体感品質とコストは大きく改善します。
- その次に効くのが **max-wait** と **グローバル並行制御**です。会話が止まらないチャンネルと同時多発だけで、MVPが壊れます。([docs-lodash.com][2])

---

## 推奨既定値

- DM micro-batch: `idleMs=200ms`, `maxWaitMs=1000ms`
- channel/group: `idleMs=3000ms`, `maxWaitMs=30000ms`
- Pending Flusher: `intervalMs=300000`（5分）
- global concurrency: `maxConcurrentAgentRuns=3`
- Route LLM: `timeoutMs=1000`, `confidenceThreshold=0.7`（未満は `note` 寄り）
- 通知疲れ対策: soft limit（クールダウン＋要約）を通知フィルター層で実装([ロイターズ研究所][3])

---

## 例と反例

### 例

DMで「サーバー落ちてる！」が連投

- `idleMs=200ms` で1塊にして即 `immediate` → 重エージェント起動は1回、体感遅延ほぼなし。

### 反例

チャンネルで1分間ずっと会話が流れ続ける

- `idleMs`だけだと永遠に塊が閉じない → `maxWaitMs=30s` で強制フラッシュして “要点だけ” を `note/respond` に分岐。([docs-lodash.com][2])

---

## 次アクション

- `memory/timeline.jsonl` の **レコード定義に `sessionKey` を必須追加**し、Heartbeat/Flusher を **sessionKey別 watermark**に改修する
- アテンションウィンドウに **`maxWaitMs` を追加**して無限待機を潰す（DMはmicro-batch）([docs-lodash.com][2])
- LLMの出力は **必須ツール呼び出し**（`report_route_decision`, `report_heartbeat_status`）に統一し、文字列マッチを削除する([OpenAI][5])
- **グローバル並行制御キュー**を追加し、優先度付きで起動スパイクを抑える([System Overflow][4])
- FlusherにトリアージLLMを入れるかは、まず「不要救済の比率」をログで測ってから決める（高ければ層2分類器を再利用）

* [ガーディアン](https://www.theguardian.com/media/2025/jun/20/increase-alert-fatigue-phone-users-disable-news-notifications-study-finds?utm_source=chatgpt.com)

[1]: https://developers.openai.com/api/docs/guides/structured-outputs/?utm_source=chatgpt.com "Structured model outputs - OpenAI API"
[2]: https://docs-lodash.com/v4/debounce/ "_.debounce – Lodash Docs v4.17.11"
[3]: https://reutersinstitute.politics.ox.ac.uk/digital-news-report/2025/walking-notification-tightrope-how-engage-audiences-while-avoiding?utm_source=chatgpt.com "Walking the notification tightrope: How to engage audiences ..."
[4]: https://www.systemoverflow.com/learn/rate-limiting/sliding-window/token-bucket-burst-control-for-rate-limiting?utm_source=chatgpt.com "Token Bucket: Burst Control for Rate Limiting"
[5]: https://openai.com/ja-JP/index/introducing-structured-outputs-in-the-api/?utm_source=chatgpt.com "API に Structured Outputs を導入 - OpenAI"
