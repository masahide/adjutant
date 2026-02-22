## GPT案

以下は **LLM（Large Language Model。大規模言語モデル）利用箇所に限定**した設計レビューです。
結論として、**2段階（軽量判定→高度実行）自体は合理的**ですが、現仕様のままだと **「通知過多」と「未処理取りこぼし」** が起きやすい構造が見えます。
特に **`PrimaryClassifier` のデフォルトが `run`**、および **Heartbeat の「統合タイムライン逆走査境界」がグローバル**に見える点がリスクです。
改善は **fail-closed（保留優先）**・**セッション別状態**・**軽量判定の学習/近傍（kNN）化**・**Structured Outputs で出力厳格化**・**通知疲れを抑える評価/予算化** が有効です。 ([arXiv][1])

---

## LLM利用箇所 — 結論の要点

仕様上の LLM 利用は、大きく次に分かれます（ここを前提にレビューします）。

- **ルーティング用 LLM**: `TriggerFilter.secondaryClassifier`（Route LLM）が `run/pending` を判定（`ADJUTANT_ROUTE_LLM_TIMEOUT_MS=1000`）。
- **本処理 LLM**: `agent-runner.ts` が **メインの高度エージェント**（会話、ツール、要約、判断）を実行。
- **定期巡回 LLM**: `Heartbeat` が未処理判定後にエージェントを自律起動。
- **埋め込み LLM**: `memory_search` が **埋め込み（embedding）** で検索（FTS5 + vec）。

2段階（軽量判定→高度実行）は、研究的にも **モデルカスケード**（Model cascade。小モデルで判定し必要時のみ大モデルへ）として費用対効果を出しやすい方向です。 ([arXiv][1])

---

## Fast Path 2段階（軽量判定→高度実行）— 結論の要点

### 目的適合性

この層の目的は実質的にこうです。

- **高頻度イベント（Slack post/reaction/notification）を全部「本処理」に流さない**
- それでも **緊急/重要（質問、依頼、締切、メンション等）** は遅延させない

この狙いは正しいです。実際、カスケードは **高価なモデル呼び出し頻度を下げつつ品質を維持**できることが報告されています。 ([arXiv][1])

### いちばん危ない点

**`PrimaryClassifier` がデフォルト `"run"`** と明記されているのは、プロダクト目的（通知の制御、ノイズ抑制）と逆向きです。
Route LLM が **無効/タイムアウト/落ちた** ときに **fail-open（全部実行）** へ倒れやすく、Slackイベントが多い環境だと **通知過多・コスト増・ユーザー離脱** につながります。
通知設計の文脈でも「過剰通知はアラート疲れ（notification fatigue）を招く」ことが強く示されています。 ([arXiv][2])

### 2段階判定を「本当に大丈夫」にする条件

2段階は、次の2条件が揃うと安定します。

1. **fail-closed（保留優先）**

- LLM が落ちたら `pending` に倒す（少なくとも channel/group では）
- DM や明示メンションだけ deterministic に `run` など、チャネル種別で例外を作る

2. **軽量判定の「信頼度」を設計に入れる**

- 「小モデルが自信ある時だけ `run`、自信が無いときは `pending`」がカスケードの基本形です（confidence check / defer）。 ([Google Research][3])

あなたの仕様の Route LLM は `confidence?` を持てる形なので、ここを本気で使うのが筋です。

### ルーティング LLM を「LLMに頼りすぎない」選択肢

ルーティングは LLM だけでなく、**埋め込み + 近傍探索（kNN）**のような単純手法が強いケースがあります（複雑な学習ルータより効率的で競争力があるという指摘）。 ([OpenReview][4])
つまり、Route LLM を常時叩くよりも、

- まず **埋め込み + kNN** で「過去に `run` だった近い事例があるか」を見る
- それでも曖昧な時だけ Route LLM

の方が、**レイテンシ/コスト/再現性**の面で強い可能性があります。

### 出力契約の堅牢化

Route LLM は「契約外値・不正 JSON で deterministic にフォールバック」とありますが、ここは **Structured Outputs（JSON Schema 厳格準拠）** を使うと、そもそも「壊れたJSON」を激減できます。 ([OpenAI Developers][5])
ルーティングは下流制御の根幹なので、**スキーマ厳格化は費用対効果が高い**です。

---

## Heartbeat（未処理通知を拾う）— 結論の要点

### 目的適合性

Heartbeat の目的は「Fast Path が `pending` にしたものや取りこぼしを、定期的に回収してユーザーに価値を返す」ことです。
**プロアクティブ通知**には、(1)ユーザー制御、(2)抑制/集約、(3)割り込み最適化が重要だという議論が多く、Heartbeat はその枠組みに入ります。 ([arXiv][6])

### 大きい設計リスク

仕様文面のままだと、Heartbeat の未処理判定は **セッション境界が曖昧**です。

- データソースが `memory/timeline.jsonl`（全チャネル・全セッション集約）
- 逆走査の「対応境界」が `role="assistant"/"tool"/recordType="action"` の **最初の1件**
- しかし §3.10 の統合タイムラインレコード定義に **`sessionKey` が出てこない**

この形だと、直近にどこかのセッションで assistant が動いた瞬間、**別セッションの未処理を境界の外に追いやって見落とす**可能性があります。
もし実装では `sessionKey` を入れているなら仕様に追記すべきで、入れていないなら設計として危険です（「未処理を拾う」が目的なので）。

### Heartbeat のLLM呼び出しを「重くしすぎない」

現在は未処理判定でいきなり **メインエージェント起動**に見えます。これだと

- 高頻度チャンネルで **30分ごとに重い推論**が走る
- しかも通知抑制が「本文一致」中心だと、ちょっと文言が変わるだけで通知が増える

になりやすいです。通知疲れ・アラート疲れは既知の失敗パターンなので、**抑制/集約/段階化**を「LLMの前段」で強化するのが安全です。 ([arXiv][2])

---

## 改善案（目的達成の確度を上げる）— 結論の要点

### 改善案A　`PrimaryClassifier` を fail-closed にする

- channel/group: **デフォルト `pending`**（明示トリガだけ `run`）
- DM: デフォルト `run`（遅延の許容度が低い）
- Route LLM は **`run` を「昇格」する役**に限定（落ちても `pending` で安全）

これは通知疲れを避ける基本に沿います。 ([jisem-journal.com][7])

### 改善案B　ルータを「kNN + 必要時だけ Route LLM」にする

- まず埋め込みで近傍（kNN）判定
- 曖昧なら Route LLM
- ルーティング研究では、単純な kNN が複雑ルータに匹敵/優位なことがある指摘があります。 ([OpenReview][4])

### 改善案C　Route LLM の出力を Structured Outputs で固定

- `RouteDecision`（または `{ outcome, confidence, reason }`）を **JSON Schema で厳格化**
- パース失敗や契約外を実運用でほぼ消し、フォールバックの発動率を下げる ([OpenAI Developers][5])

### 改善案D　Heartbeat を「トリアージ（軽量）→本処理（重い）」に分割

Heartbeat は Fast Path と同じくカスケードにできます。

1. トリアージ（軽量）

- 直近未処理候補を **短いコンテキストで分類**（緊急度、要返信、タスク化、単なる閲覧でOK）
- 結果は **構造化**（例: `should_notify`, `severity`, `action_items[]`）

2. 本処理（重い）

- `should_notify=true` の時だけメインエージェント起動
- 「通知本文生成」は必要時のみ

アラート疲れを減らす枠組み（選択的発報・抑制・集約）と整合します。 ([arXiv][2])

### 改善案E　未処理判定を sessionKey 単位にする

- `timeline.jsonl` レコードに **`sessionKey`（または `channelId`）を必須化**
- 「対応境界」も **`sessionKey` ごと**に持つ（`lastHandledAtBySessionKey` 的な小さな状態を JSONL/SQLite で保持）
- これで Heartbeat が「拾うべきもの」を正しく拾える

---

## 注記

- **ルーティング**: ここでは「`run/pending/drop/system` の経路選択」を指します。
- **モデルカスケード**: 小さいモデル（または軽量処理）で判定し、必要なときだけ大きいモデルに委譲する設計です。 ([arXiv][1])
- **通知疲れ**: 通知が多すぎることで重要通知を見落とす/無視する状態です（アラート疲れとも近い概念）。 ([arXiv][2])

---

## 見解

この仕様の「方向性」は良いです。
ただし **LLM の置き方が fail-open（落ちたら実行）に寄っている**のと、Heartbeat の未処理検出が **セッションをまたいで正しく動かない恐れ**があり、目的（必要な時だけ賢く介入）と衝突します。
「最終的に拾える」ことより、「拾うべきものを落とさず、拾わなくていいものに介入しない」ことが UX と運用コストを決めます。

---

## 推奨既定値

- `PrimaryClassifier`
  - `C*`/`G*`: **デフォルト `pending`**
  - `D*`（DM）: デフォルト `run`

- Route LLM
  - **温度 0**（再現性）
  - `confidence` を必須運用（例: `confidence >= 0.8` だけ `run`）
  - 出力は Structured Outputs（JSON Schema strict） ([OpenAI Developers][5])

- Heartbeat
  - 未処理判定は **`sessionKey` 単位**
  - 先にトリアージを挟み、**本処理の起動回数に上限（予算）**を持たせる ([arXiv][2])

---

## 例と反例

### 例 — 目的に沿う挙動

- DM（`sessionKey=slack:D...`）で「今日中に返答必要？」のような明示質問
  - deterministic で `run`
  - 即時に高度エージェントが返答
  - Heartbeat は追加介入しない

### 反例 — 現仕様だと起きやすい問題

- パブリック channel（`slack:channel:C...`）で雑談・絵文字多めの投稿が連続
  - `PrimaryClassifier` デフォルト `run` だと本処理が頻発
  - 通知過多でユーザーが無視し始め、重要メッセージも埋もれる（通知疲れ） ([Nature][8])

---

## 次アクション

- `TriggerFilter` の **デフォルト方針を fail-closed（保留優先）へ変更**し、DM/メンションのみ例外で `run` にする
- `memory/timeline.jsonl` に **`sessionKey` を仕様として必須化**し、Heartbeat の未処理判定も sessionKey 単位へ修正する
- Route LLM の出力を **Structured Outputs（JSON Schema strict）** に切り替える ([OpenAI Developers][5])
- ルーティングを **埋め込み + kNN（近傍）** で置き換える/併用する PoC を作り、Route LLM 呼び出し率を下げる ([OpenReview][4])
- Heartbeat を **トリアージ→本処理** の2段にし、通知回数・誤通知率・未対応取りこぼし率の KPI を置いて評価する ([arXiv][2])

[1]: https://arxiv.org/abs/2305.05176?utm_source=chatgpt.com "FrugalGPT: How to Use Large Language Models While ..."
[2]: https://arxiv.org/pdf/2003.02097?utm_source=chatgpt.com "A Snooze-less User-Aware Notification System for Proactive ..."
[3]: https://research.google/blog/speculative-cascades-a-hybrid-approach-for-smarter-faster-llm-inference/?utm_source=chatgpt.com "A hybrid approach for smarter, faster LLM inference - Google ..."
[4]: https://openreview.net/pdf?id=Chn50flK4X&utm_source=chatgpt.com "RETHINKING PREDICTIVE LLM ROUTING: WHEN SIMPLE ..."
[5]: https://developers.openai.com/api/docs/guides/structured-outputs/?utm_source=chatgpt.com "Structured model outputs - OpenAI API"
[6]: https://arxiv.org/abs/2410.04596?utm_source=chatgpt.com "Need Help? Designing Proactive AI Assistants for Programming"
[7]: https://jisem-journal.com/index.php/journal/article/download/12841/5982/21634?utm_source=chatgpt.com "Designing Proactive Notification Systems for Intelligent ..."
[8]: https://www.nature.com/research-intelligence/nri-topic-summaries/user-interruptibility-and-notification-management-in-mobile-devices-micro-1803?utm_source=chatgpt.com "User Interruptibility and Notification Management in Mobile ..."

---
