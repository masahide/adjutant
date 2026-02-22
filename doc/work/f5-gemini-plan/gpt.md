# gptからのfeedback

要約

- Gemini最終案は、**会話塊化→軽量分類→重エージェント起動**の順に整理できていて、MVPとしてかなり「壊れにくい」形です。
- ただし **`MEMORY.md` の spoke 参照**と、**SlackのIDプレフィクス依存**、**watermark のアルゴリズム定義不足**が残っています。
- まず着手すべきは、`memory/timeline.jsonl` の **`sessionKey` 必須化**と、`memory/watermarks.json` の **型・更新規約・復旧規約**の明文化です（ここが崩れると救済が死ぬ）。

---

## Gemini最終案 — 良いところと採用判断

### 採用してよい点

- **イベント単位から会話塊（チャンク）単位へ**の移行は正解です（LLM呼び出し回数・誤判定・重エージェントの連発を同時に下げる）。
- **`idleMs` と `maxWaitMs`**を分けた設計は、debounce の典型オプション `maxWait` に沿っており、無限待機を避けられます。([docs-lodash.com][1])
- **構造化出力を「必須ツール呼び出し」で実現**するのは、SDK制約がある前提では最も堅いです（文字列マッチより圧倒的に安全）。OpenAI側も `strict=true` を推奨しています。([OpenAI Developers][2])
- **グローバル並行制御**は必須。瞬間スパイク対策は token bucket のような「バースト許容＋平均抑制」が実務でよく使われます。([System Overflow][3])
- **通知予算（soft limit）**の方針は妥当。通知は送りすぎると無効化されやすく、運用側も日次上限などを意識している、という知見と整合します。([ロイターズ研究所][4])

---

## Gemini最終案 — 反証と要修正ポイント

### `MEMORY.md` 参照方針 — spoke 参照は仕様違反になり得る

Gemini案の「spokeセッションでも内部ルーティング判定のみに `MEMORY.md` を参照」は、あなたの v1.0 仕様 §13 の **「spokeはメモリロード禁止」**と衝突します。
“外部に露出しない” でも **参照自体が禁止**ならNGです。

**修正案**

- spoke が参照してよいのは `MEMORY.md` ではなく、**通知・ルーティング専用の非個人情報ポリシー**に限定する
  - 例: `memory/POLICY_ROUTING.json`（チャンネル優先度、静穏時間、通知上限、confidence閾値など）

### SlackのIDプレフィクス依存 — 将来破綻し得る

現在の `sessionKey` マッピングが `D* / G* / C*` 前提ですが、Slack自身が「共有チャンネル等でIDプレフィクスが変わる」旨を言及しています。([Slack Developer Docs][5])
つまり、**プレフィクスだけでDM/プライベート等を断定しない**のが安全です。

**修正案**

- `conversations.view` などで取得できる **channel type情報（private / im / mpim / shared 等）**をキャッシュに保持し、ルール判定（DM即時など）はそちらを優先する（プレフィクスは最後のフォールバック）

### `memory/watermarks.json` — “O(1)スキャン”の定義がまだ曖昧

「巨大timelineの毎回全走査を防ぐ」は正しいが、`watermarks.json` の型と更新ルールが曖昧だと、結局

- 破損で全走査に戻る
- 境界更新の取りこぼしで永久未対応が出る
  になりがちです。

**最低限、以下を仕様化すべきです**

- watermark の **単位**（`sessionKey` 単位で確定）
- watermark の **意味**（「どこまでスキャンしたか」と「どこまで対応済みか」は別概念）
- **原子的（atomic）更新**（temp書き→rename など）
- timeline 修復（truncate）時の **watermark再整合**（オフセットが飛んだらどうするか）

---

## データモデル変更 — ドラフト

### `memory/timeline.jsonl` — レコード定義 v1.5案

現行 §3.10 を置き換える最小差分です。

```ts
type TimelineRecordV1_5 = {
  schema: "adjutant.timeline.record.v1.5";
  recordType: "event" | "action";
  role: "user" | "assistant" | "tool";

  // 追加: セッション境界の根拠
  sessionKey: string; // MUST
  ts: string; // ISO8601 (既存と合わせる)

  // 既存: イベントの識別
  kind?: string; // "post" | "reaction" | "notification" | ...
  uid?: string; // NormalizedEvent.uid

  // 追加推奨: Flusherの抑制判定・デバッグ用（本文は入れない）
  actor?: string; // Slack user id 等（PIIは避けるならIDのみ）
  threadTs?: string;
  channelId?: string;
  accountId?: string;
};
```

#### 互換方針

- 既存の `schema` が無い/古い行は **受理**する
- ただし `sessionKey` が無い行は、Flusher の判定対象から外す（安全側）
  - 例外として、`uid` から `channel_id` を取り出せるなら推定しても良いが、MVPは「無視」でもよい

### `memory/watermarks.json` — 型定義 v1案

「スキャン進捗」と「対応境界」を分離して持つのがコツです。

```ts
type WatermarksV1 = {
  schema: "adjutant.watermarks.v1";
  timelinePath: "memory/timeline.jsonl";
  updatedAt: string; // ISO8601

  // timeline をどこまで読んだか（全体の進捗）
  global: {
    lastScannedOffset: number; // byte offset
    lastScannedTs?: string;
  };

  // sessionKey ごとの状態
  sessions: Record<
    string,
    {
      // 対応済み境界（この時刻/このoffset以前は「処理済み」とみなす）
      lastHandledTs?: string;

      // 未対応候補の最古（stale 判定用）
      oldestOpenUserPostTs?: string;

      // 省メモリ: UIDsは上限つき（例えば最大200）
      openEventUids?: string[];
    }
  >;
};
```

### Pending Flusher の読み書きロジック — 擬似アルゴリズム

- `watermarks.json` をロード
- `timeline.jsonl` を `global.lastScannedOffset` から末尾まで **追い読み**
- 各行を `TimelineRecordV1_5` としてパースし、`sessionKey` ごとに以下を更新
  - `role in {"assistant","tool"}` または `recordType="action"` を見たら `lastHandledTs` を更新し、`open*` をクリア
  - `recordType="event" && role="user" && kind="post"` を見たら、`lastHandledTs` より後なら `open` に積む（`oldestOpenUserPostTs` 更新）

- 走査終了時に `global.lastScannedOffset` を末尾に更新して `watermarks.json` を原子的更新
- stale 判定（例: `now - oldestOpenUserPostTs >= ADJUTANT_HEARTBEAT_STALE_MS`）を満たす `sessionKey` を層3キューへ投入

---

## LLMツール設計 — `report_route_decision` と `report_heartbeat_status`

### `report_route_decision` — 会話塊分類の必須出力

「文字列で返す」を禁止し、ツール呼び出しで分岐します。

```json
{
  "name": "report_route_decision",
  "strict": true,
  "parameters": {
    "type": "object",
    "properties": {
      "action": { "type": "string", "enum": ["respond", "note", "ignore"] },
      "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
      "reason": { "type": "string" }
    },
    "required": ["action", "confidence"]
  }
}
```

`strict=true` でスキーマ逸脱を抑制できる、というのが OpenAI の推奨です。([OpenAI Developers][2])

### `report_heartbeat_status` — Heartbeatの必須出力

```json
{
  "name": "report_heartbeat_status",
  "strict": true,
  "parameters": {
    "type": "object",
    "properties": {
      "status": { "type": "string", "enum": ["no_action", "needs_attention", "failed"] },
      "notify": { "type": "boolean" },
      "reason": { "type": "string" }
    },
    "required": ["status", "notify"]
  }
}
```

---

## 改善提案 — 最終案に足すと効くもの

1. **spoke用のポリシーファイルを分離**
   - `MEMORY.md` は main 専用のまま
   - spoke は `POLICY_ROUTING.json` のみ参照

2. **DM/メンションは “遅延ゼロ” ではなく micro-batch**
   - 体感即時を保ちつつ、分割送信を1回にまとめる

3. **Slack種別判定はプレフィクス依存を弱める**
   - 共有チャンネル等でIDプレフィクスが変わり得るため、type情報キャッシュを優先する([Slack Developer Docs][5])

4. **通知予算は soft limit を基本**
   - “重要通知が抑制される事故”を避けるため、抑制ではなく「要約・クールダウン・同一話題マージ」を中心に
   - 過剰通知は無効化につながり得るため、設計として持つ価値が高い([ロイターズ研究所][4])

---

## 注記

- LLM — Large Language Model。ここでは「軽量分類モデル」と「重い応答生成エージェント」を区別して扱う。
- debounce — 一定時間入力が止まるまで処理を遅らせる。`maxWait` は遅延の上限で、無限待機を防ぐためにある。([docs-lodash.com][1])
- watermark — 「どこまで見たか」「どこまで処理したか」を表す永続状態。両者を混ぜると破綻しやすい。

## 見解

Gemini最終案は、v1.0 の最大の地雷だった「グローバル境界で未処理が永久に隠れる」を正面から潰しつつ、LLM起動回数も抑える方向でまとまっています。
残るリスクは、**spokeメモリ参照の仕様衝突**と、**watermarkの定義不足**と、**Slack種別判定の将来不整合**です。ここを仕様として固めれば、実装フェーズに移れます。

## 推奨既定値

- DM/メンション: `idleMs=200ms`, `maxWaitMs=1000ms`
- チャンネル/グループ: `idleMs=5000ms`, `maxWaitMs=60000ms`（`maxWait` は無限待機防止に必須）([docs-lodash.com][1])
- `confidenceThreshold`: `0.7`（未満は `note`）
- グローバル同時実行: `maxConcurrent=3`（token bucket的にバーストを抑える）([System Overflow][3])
- 通知予算: soft limit（上限超過時は要約・クールダウン）([ロイターズ研究所][4])

---

## 例と反例

### 例

チャンネルで短文が断続的に続く

- `idleMs` で塊化、`maxWaitMs` で強制フラッシュ
- 軽量分類が `note` なら重エージェントは起動せず、次回の文脈に積む

### 反例

`maxWaitMs` が無い設計で、会話がずっと続くチャンネル

- debounce が永遠にリセットされ、分類も起動も発生しない（無反応に見える）
- `maxWait` はこの罠を避けるための標準オプション([docs-lodash.com][1])

---

## 次アクション

- `memory/timeline.jsonl` の `schema` を `adjutant.timeline.record.v1.5` に更新し **`sessionKey` を必須化**する
- `memory/watermarks.json` を上の `WatermarksV1` として仕様化し、**原子的更新**と **timeline修復時の再整合**ルールを決める
- spoke の参照情報を `MEMORY.md` から切り離し、`POLICY_ROUTING.json` を新設する
- `report_route_decision` / `report_heartbeat_status` を必須ツールとして追加し、文字列マッチを削除する([OpenAI Developers][2])

* [ガーディアン](https://www.theguardian.com/media/2025/jun/20/increase-alert-fatigue-phone-users-disable-news-notifications-study-finds?utm_source=chatgpt.com)

[1]: https://docs-lodash.com/v4/debounce/ "_.debounce – Lodash Docs v4.17.11"
[2]: https://developers.openai.com/api/docs/guides/function-calling?utm_source=chatgpt.com "Function calling | OpenAI API"
[3]: https://www.systemoverflow.com/learn/rate-limiting/sliding-window/token-bucket-burst-control-for-rate-limiting?utm_source=chatgpt.com "Token Bucket: Burst Control for Rate Limiting"
[4]: https://reutersinstitute.politics.ox.ac.uk/digital-news-report/2025/walking-notification-tightrope-how-engage-audiences-while-avoiding?utm_source=chatgpt.com "Walking the notification tightrope: How to engage audiences ..."
[5]: https://docs.slack.dev/apis/web-api/using-the-conversations-api/?utm_source=chatgpt.com "Using the Conversations API | Slack Developer Docs"
