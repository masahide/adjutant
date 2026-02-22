# gptのフィードバック

- **`watermarks.json` は「スキャン進捗」と「対応境界」を別概念として固定**し、前者は byte offset、後者は **`sessionKey` 別の“対応完了マーカー位置（offset）”**で持つのが最も安全です。
- **`lastHandledTs` 更新は `actionType="assistant_final"` のみ**に限定し、`tool`／`tool_result` では絶対に境界を進めない（途中ツールで未返信が“処理済み扱い”になる事故を防ぐ）。
- **starvation 対策は「(A) クラス別同時実行上限 + (B) DRR/W-RR + (C) aging + (D) token bucket」**をセットで入れるのが堅いです。([en.wikipedia.org](https://en.wikipedia.org/wiki/Deficit_round_robin?utm_source=chatgpt.com) , [en.wikipedia.org](https://en.wikipedia.org/wiki/Aging_%28scheduling%29?utm_source=chatgpt.com) , [www.geeksforgeeks.org](https://www.geeksforgeeks.org/computer-networks/token-bucket-algorithm/?utm_source=chatgpt.com))

---

## watermarks.json — スキャン進捗と対応境界を分離する提案

### 目的 — 結論の要点

- **スキャン進捗**は「`timeline.jsonl` をどこまで読んだか」を表す **I/O の再開点**
- **対応境界**は「その `sessionKey` がどこまで“応答完了した”か」を表す **意味論の境界**
- **対応境界は timestamp ではなく “ログ位置（offset）” で持つ**のが重要（遅延到着イベントで取りこぼしを防ぐ）

Slack等はイベントが遅れて到着し得るため、「`event.ts < lastHandledTs` だから処理済み」は誤判定になり得ます。**ログに“後から追記された”事実**のほうが「エージェントが見ていない」ことを示します。

### スキーマ案（Gemini案からの差分）

Gemini案の `WatermarksV1` を次のように拡張するのを推奨します（**`lastHandledOffset` 追加**が肝）。

```ts
type WatermarksV1 = {
  schema: "adjutant.watermarks.v1";
  updatedAt: string; // ISO8601

  scan: {
    timelinePath: "memory/timeline.jsonl";
    lastScannedOffset: number; // 次回の追い読み開始位置（byte offset）
    lastGoodOffset: number; // JSON parse 成功した最後の安全位置（末尾不完全対策）
  };

  sessions: Record<
    string /*sessionKey*/,
    {
      handled: {
        lastHandledOffset?: number; // ★境界は offset を正とする（遅延到着に強い）
        lastHandledTs?: string; // 監視/デバッグ用（意味論には使わない）
        lastHandledRunId?: string; // 任意
      };

      open: {
        oldestOpenOffset?: number; // 未対応候補の最古 offset（説明や再構築に便利）
        oldestOpenPostTs?: string; // stale 判定用（年齢は ts を使う）
        openPostCount?: number; // 上限付き
        openUidsSample?: string[]; // 上限付き（例: 50）
      };

      attempts?: {
        cooldownUntilTs?: string; // 失敗ループ抑止（任意だが実運用で効く）
      };
    }
  >;
};
```

### 更新ルール（差分走査の定義）

1. `scan.lastScannedOffset` から `timeline.jsonl` を追い読み
2. 1行ごとに **「行頭の byte offset」**を計測しつつ JSON parse
3. parse 成功したら `scan.lastGoodOffset` を更新
4. 末尾不完全で parse 失敗したら **`lastGoodOffset` までで終了**（次回リトライ）

`watermarks.json` の更新は **tmp 書き → rename**（同一FS内）で原子的に置換するのが定石です。POSIX の `rename()` は「古いか新しいかのどちらか」になりやすく、部分書き込みを露出しにくいです。([stackoverflow.com](https://stackoverflow.com/questions/7054844/is-rename-atomic?utm_source=chatgpt.com) , [python-atomicwrites.readthedocs.io](https://python-atomicwrites.readthedocs.io/en/latest/?utm_source=chatgpt.com) , [www.npmjs.com](https://www.npmjs.com/package/write-file-atomic?utm_source=chatgpt.com))

### 自己修復（truncate 復旧）ルールの補強

Gemini案どおり「ファイルサイズ < lastScannedOffset なら 0 に戻す」は正しいです。
追加で、**`sessions[*].handled.lastHandledOffset` も無効化**して全走査で再構築するのが安全です（truncateで境界位置が消えるため）。

---

## lastHandledTs — 境界イベント定義の提案

### 目的 — 結論の要点

- 境界を進めるのは **`actionType="assistant_final"` のみ**
- `tool` を境界にしない（途中のツールで“対応済み”扱いになる事故を防ぐ）
- 境界は **ts ではなく offset**を正とし、`lastHandledTs` は補助情報に格下げ

### timeline に追加すべき「境界アクション」

Gemini案の `TimelineRecordV1_5` は良いです。ここに **run終端状態**を足して、観測/冷却に使えるようにするのを推奨します。

```ts
type TimelineActionV1_5 = {
  schema: "adjutant.timeline.record.v1.5";
  recordType: "action";
  role: "assistant";
  sessionKey: string;
  ts: string; // ISO8601
  actionType: "assistant_final" | "assistant_aborted" | "assistant_error";
  runId: string;
};
```

### `lastHandled*` 更新規則

- `assistant_final` を見たら
  - `handled.lastHandledOffset = <その行頭offset>`
  - `handled.lastHandledTs = ts`
  - `open.*` をクリア

- `assistant_aborted` / `assistant_error` は
  - **handled を進めない**（未対応のままだから）
  - 代わりに `attempts.cooldownUntilTs` を入れて無限リトライを抑える（任意）

### ツール呼び出し結果の構造化（仕様整合）

Gemini案の「`report_route_decision` を必須」「`parallel_tool_calls: false`」は正しい方向です。OpenAI側でも Structured Outputs（スキーマ制約）を強化する文脈で **ツール呼び出し + `strict`**が中核になります。([openai.com](https://openai.com/ja-JP/index/introducing-structured-outputs-in-the-api/?utm_source=chatgpt.com))

---

## グローバル並行制御 — starvation（飢餓）対策の提案

### 目的 — 結論の要点

「優先度だけ」のキューは、DMが連続するとチャンネルが永久保留になります。
対策は **公平性（fairness）**をスケジューラに入れることです。

### 推奨する3つの仕掛け

1. 起動レート制限 — token bucket（バースト許容＋平均抑制）([www.geeksforgeeks.org](https://www.geeksforgeeks.org/computer-networks/token-bucket-algorithm/?utm_source=chatgpt.com))
2. 公平スケジューリング — DRR（Deficit Round Robin）か weighted round robin（コスト一定なら簡略版で十分）([en.wikipedia.org](https://en.wikipedia.org/wiki/Deficit_round_robin?utm_source=chatgpt.com))
3. aging — 待ちすぎたタスクをブーストして starvation を防ぐ([en.wikipedia.org](https://en.wikipedia.org/wiki/Aging_%28scheduling%29?utm_source=chatgpt.com))

### Gemini案の「DM Burst Slot +1」への修正提案

`+1` 専用スロットは「DM優先」を強めますが、**非DMの starvation を悪化**させ得ます。代わりに次を推奨します。

- `maxConcurrent=3` は固定
- **クラス別同時実行上限**を導入（これが一番効く）
  - 例: `maxRunningDM=2`（= 非DM用に最低1枠を確保）

- その上で DRR + aging で順番を回す

これで「DMが止まらない」状況でも **チャンネルが必ず前進**します。

### 実装ルール（仕様として書ける粒度）

- キューはクラス別（DM / group / channel / flusher / heartbeat）
- ディスパッチ条件:
  - 空きスロットあり
  - token bucket にトークンあり
  - クラス別 `maxRunning` を満たす

- 選択:
  - aging で「待ち > starvationMs」の先頭タスクがあれば最優先
  - なければ DRR（quantum: DM=5, group=3, channel=2, flusher=1, heartbeat=1）

---

## 注記

- conversation type 判定は、IDプレフィクスではなく conversation object の `is_im` / `is_mpim` 等を正にするのが安全です。([docs.slack.dev](https://docs.slack.dev/reference/objects/conversation-object/))
- `maxWaitMs` は debounce が永遠にリセットされる問題を避けるための一般的な発想です（類似の議論として `maxWait` が扱われます）。([stackoverflow.com](https://stackoverflow.com/questions/24079736/confused-about-the-maxwait-option-for-lodashs-debounce-method?utm_source=chatgpt.com))

## 見解

- 3点の中で最も事故りやすいのは **境界を ts で持つ設計**です。遅延到着で「見ていないイベント」が `ts` 比較で消えるので、**境界は offset（ログ位置）を正**にしてください。
- starvation は「優先度を上げれば上げるほど起きる」ので、優先度より **公平性（順番が回る仕組み）**を軸に据えるのが安全です。

## 推奨既定値

- watermarks:
  - `openUidsSample` 上限 `50`
  - `openPostCount` 上限 `999`

- 境界:
  - `assistant_final` のみ handled を更新

- concurrency:
  - `maxConcurrent=3`
  - token bucket: `rate=2 starts/sec`, `burst=3`
  - `maxRunningDM=2`（非DMに最低1枠）
  - `starvationMs=120000`（2分）
  - quantum: `DM=5, group=3, channel=2, flusher=1, heartbeat=1`

---

## 例と反例

### 例

DMが連続しても `maxRunningDM=2` により最低1枠はチャンネルに回り、agingで「待ちすぎチャンネル」は必ず実行される。([en.wikipedia.org](https://en.wikipedia.org/wiki/Aging_%28scheduling%29?utm_source=chatgpt.com))

### 反例

`lastHandledTs` を tool 実行で更新する

- 回答途中の tool で境界が進み、未返信の user post が「処理済み扱い」になって Flusher が拾えなくなる（取りこぼしが恒久化）

---

## 次アクション

- `watermarks.json` を **`lastHandledOffset` 追加**の形で確定し、差分走査（末尾不完全対策込み）の更新規則を仕様に追記する
- `timeline.jsonl` に **`assistant_final/aborted/error`** の action を追加し、**handled 更新は `assistant_final` のみ**と明文化する
- グローバル並行制御は **クラス別 `maxRunning` + DRR + aging + token bucket**で実装し、待ち時間メトリクス（最大待ち）を出す
