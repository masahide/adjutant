# gptからのフィードバック

- 修正版ドラフトは、懸念3点のうち **watermark分離**と **`assistant_final` 境界**はほぼ要件を満たしています。
- 残りのリスクは **stale 判定の時刻ソース（`logged_at` を timeline に持っていない問題）**と、並行制御の **飢餓対策の「仕様化不足」**です。
- 提案は、(1) timeline に **`loggedAt` を正式フィールド追加**、(2) handled 境界は **offsetのみを正**、(3) 並行制御は **非DM1枠保証 + agingの定義固定 + work-conserving**で固める、です。([turn0search0](https://docs.slack.dev/reference/objects/conversation-object/) , [turn1search7](https://developers.openai.com/api/docs/guides/function-calling) , [turn2search5](https://stackoverflow.com/questions/24079736/confused-about-the-maxwait-option-for-lodashs-debounce-method))

---

## watermarks.json — 状態定義の最終提案

### 結論の要点

- いまのドラフト（`scan` と `sessions.handled/open`）は正しい方向です。
- ただし **`oldestOpenPostTs=logged_at` と書いているのに、timeline側のイベント行が `logged_at` を持たない**ため、仕様として不整合です（実装で揉めます）。
- **境界判定は offset を正**にする方針は正しいので、**stale 判定だけ “記録時刻” を別フィールドで担保**してください。

### 仕様差分として入れるべき最小追加

`TimelineRecordV1_5`（event行）に **`loggedAt`** を追加し、Flusher の stale はこれを使う。

```ts
// 追加フィールド（event行）
loggedAt?: string; // ISO8601 - JsonlWriter が補完した記録時刻（stale判定の正）
```

理由: 起動直後に過去ログが流入すると、Slack側の `ts`（イベント時刻）が古くて即 stale になり誤発火しやすい。**記録時刻**を基準にすると安定します。

### scan と handled の役割を仕様に明記

- `scan.lastScannedOffset` — “追い読み開始位置”。I/O進捗
- `scan.lastGoodOffset` — “JSON parse成功の安全地点”。末尾不完全行対策
- `sessions[*].handled.lastHandledOffset` — “対応完了境界（assistant_finalの行頭offset）”。意味論境界
- `sessions[*].handled.lastHandledTs` — “デバッグ専用”。**ロジック分岐禁止**（ドラフトの明記は良い）

`maxWait` と同様に「無限に遅延し得るものを上限で止める」という発想は一般に説明されます。([turn2search5](https://stackoverflow.com/questions/24079736/confused-about-the-maxwait-option-for-lodashs-debounce-method))

### 永続化の推奨実装

ドラフトどおり **`.tmp` 書き→rename 差し替え**で良いです。Node でも “atomic write” の定石として広く使われ、`write-file-atomic` も同方式を採用しています。([turn1search2](https://github.com/npm/write-file-atomic) , [turn2search7](https://pubs.opengroup.org/onlinepubs/000095399/functions/rename.html))

---

## lastHandledTs 更新 — 境界イベント定義の最終提案

### 結論の要点

- ドラフトのルール「`assistant_final` だけで `lastHandledOffset` を進める」は正しいです。
- 追加で、**“1 run につき終端レコードは1回だけ”**を **テストで保証**してください（すでに文面にあり、良い）。
- `tool` / `tool_result` / `assistant_aborted` / `assistant_error` では **絶対に handled を進めない**（これもドラフトに入っていて良い）。

### 仕様に追記すると事故が減る一文

- `assistant_final` は **「ユーザーへ最終応答が確定し、SSE上も終端した」**ことの宣言
- `assistant_aborted` / `assistant_error` は **「終端したが、対応完了とはみなさない」**宣言

ツール呼び出し強制（`report_route_decision` を必ず1回）も正当化できます。OpenAIの function calling はツール呼び出しを前提にしたガイドがあり、実装契約として成立します。([turn1search7](https://developers.openai.com/api/docs/guides/function-calling))

---

## グローバル並行制御 — starvation対策の最小仕様

### 結論の要点

- 現ドラフトの修正（`totalSlots=4` と `maxRunningDM=3`）で **「非DM1枠保証」**が入ったのは大きいです。
- ただし **aging の定義が曖昧**だと、結局「優先度が強い方が勝ち続ける」実装になりやすいので、**priority boost の計算式**を仕様化してください。
- さらに **work-conserving（空き枠があるなら埋める）**を入れると、非DMが無い時に throughput が落ちません。

### 仕様化すべき3ルール

1. 非DM枠保証

- `maxRunningDM = totalSlots - 1` を守る（ドラフトに反映済み）

2. aging の定義を固定
   例:

- `effectivePriority = basePriority + boost`
- `boost = min(BOOST_MAX, floor(waitMs / boostStepMs))`
- もしくは `waitMs >= starvationMs` で `effectivePriority = PRIORITY_MAX`（単純でMVP向き）
  aging 自体は starvation 回避の典型手法として説明されます。([turn0search7](https://en.wikipedia.org/wiki/Aging_%28scheduling%29))

3. work-conserving を明記

- 非DMが空なら、**DMが予約枠も使って良い**
- 非DMが1件でも待っているなら、**予約枠は非DM専用**
  これで「保証」と「スループット」を両立できます。

### 将来拡張の位置づけ

DRR や token bucket は非スコープでよいですが、「必要になった時に移行できる」ことは文書に残すとよいです。DRR は公平性を担保する方式として知られています。([turn0search6](https://en.wikipedia.org/wiki/Deficit_round_robin))

---

## 注記

- Slackチャネル種別判定 — IDプレフィクスではなく conversation object のフラグを正にするのが安全です。([turn0search0](https://docs.slack.dev/reference/objects/conversation-object/) , [turn0search12](https://docs.slack.dev/apis/web-api/using-the-conversations-api/))
- atomic write — `.tmp`→rename 差し替えは、ファイルを壊しにくい定石で、Node向けライブラリでも採用されています。([turn1search2](https://github.com/npm/write-file-atomic))

---

## 見解

- 今のドラフトは、3点（状態分離・境界定義・飢餓対策）に対して**正しい方向へ収束**しています。
- 残る「落とし穴」は、**stale判定の時刻（`logged_at`）を timeline 側で保証していない不整合**と、**aging が実装任せで曖昧**な点です。ここを仕様に落とせば、実装フェーズでの手戻りが減ります。

---

## 推奨既定値

- `WatermarksV1`
  - `openPostCount` 上限 `999`
  - `openUidsSample` 上限 `50`（任意）

- stale 判定
  - `loggedAt` を timeline event に追加し、`oldestOpenPostTs = loggedAt` を正にする

- 並行制御
  - `totalSlots=4`, `maxRunningDM=3`（非DM1枠保証）
  - `starvationMs=120000`, agingは「超えたら最大優先度」に固定（MVP向き）([turn0search7](https://en.wikipedia.org/wiki/Aging_%28scheduling%29))

---

## 例と反例

### 例

古い Slack `ts` のイベントが「後から」`timeline.jsonl` に追記された

- 境界を **offset** で持てば、追記行は `lastHandledOffset` より後に来るため **未対応として拾える**。

### 反例

stale 判定に Slack `ts` を使う

- 起動直後に過去ログが流入すると、`ts` が古くて即 stale 扱いになり、Flusher が誤発火しやすい。

---

## 次アクション

- `TimelineRecordV1_5` の event 行に **`loggedAt` を追加**し、Flusher stale 判定の正を `loggedAt` に固定する
- GlobalConcurrencyQueue の **aging 計算式**と **work-conserving ルール**を仕様に追記し、テストで担保する
- `assistant_final/aborted/error` の「1 run 1回」終端レコードを、**テストと実装（finally）で二重に保証**する
