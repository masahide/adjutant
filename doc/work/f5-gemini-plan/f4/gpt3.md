# gptからのフィードバック

- 修正版ドラフトで、3点とも **仕様レベルでだいぶ固まりました**（`scan`/`handled` 分離、境界=`assistant_final`、starvation対策=`maxRunningDM`+aging+work-conserving）。
- 追加で詰めたいのは **`loggedAt` の取り扱い統一**（命名・必須性）と、**`lastGoodOffset` の厳密な更新規約**、それから **DM burst slot と aging の優先順位ルール**の明文化です。
- この3つを1〜2段落だけ追記すれば、実装側の解釈ブレがほぼ消えます。

---

## watermarks.json — 状態定義を仕様として固定する提案

### 現状評価

- `scan`（I/O進捗）と `sessions.handled/open`（意味論）を分離できており、方向性は正しいです。
- `TimelineRecordV1_5` に `loggedAt` を追加したことで、stale 判定（放置判定）の時刻ソースが確定し、起動直後の過去ログ流入で誤発火しにくくなります（`ts`は遅延到着で過去になり得る）。([Slack Developer Docs][1])

### 追加で「仕様として」書いておくと事故が減る点

1. `loggedAt` の必須性

- `TimelineRecordV1_5.loggedAt` は **必須**（JsonlWriter が補完）で固定した方が良いです。
  - optional だと Flusher が “不明な時刻” をどう扱うかで実装が割れます。

2. `lastGoodOffset` の運用規約（末尾不完全行対策の完成）

- Flusher tick 終了時は **`lastScannedOffset = lastGoodOffset`** を原則にする（末尾が途中で切れている時に壊れたオフセットを保存しない）。
- 末尾行が不完全で parse に失敗した場合は **「その行には触れず、次周期で再試行」**の方針を明記。

3. atomic write の「前提」を仕様に一言入れる

- `.tmp` → `fs.rename` は同一ファイルシステム内でやる前提を明記（別FSだと原子性が崩れ得る）。
  - `rename()` は既存の `new` が存在する場合、置換が“途中状態を見せにくい”契約として説明されています。([The Open Group][2])

4. `oldestOpenPostTs` の命名ゆれを解消

- コメントや本文が `logged_at` と `loggedAt` を混用しています。
  - **JSONフィールド名を `loggedAt` に統一**するか、逆に **`logged_at` に統一**するか、どちらかに寄せるべきです（実装でのバグ源）。

---

## lastHandledTs — 境界イベント定義をさらに堅くする提案

### 現状評価

- **境界を進めるトリガーが `actionType="assistant_final"` のみ**、という定義は正解です。
- `assistant_aborted` / `assistant_error` は「終端したが対応完了ではない」と明記されており、Flusher が再回収する動きと整合しています。

### 追加で「仕様として」固定するとよい点

1. `assistant_final` の意味を “SSE終端” とリンクさせる

- すでに「SSE 上も終端」と書けていますが、**終端状態（final/aborted/error）のうち final のみ**に対応する、と1文で釘を刺すと実装が揃います。

2. `lastHandledTs` は「監視用」だけにする（すでにOK）

- ここは現行の文面で十分です。`lastHandledOffset` を正にする方針は堅いです。

3. ツール強制の整合性

- `report_route_decision` を「必ず1回」とし、`parallel_tool_calls` 相当を無効にするのは、Structured Outputs/Function Calling の運用ガードとして妥当です。([OpenAI Developers][3])
  - Assistants API 側でも `strict: true` が利用できる旨が明記されています。([OpenAI Developers][4])

---

## グローバル並行制御 — starvation 対策を仕様として完成させる提案

### 現状評価

- `totalSlots=4` と `maxRunningDM=3`（非DM 1枠保証）で、**DM連打でチャンネルが永久保留**になるパターンは基本的に潰せています。
- `work-conserving` を明記したのも良いです。「仕事が待っているのにリソースを遊ばせない」スケジューラという定義に一致します。([ウィキペディア][5])
- aging を「`waitMs >= starvationMs → PRIORITY_MAX`」のステップ関数にしたのは MVP 向きです（実装がブレにくい）。starvation を避けるために待ち時間で優先度を上げるのが aging の典型です。([ウィキペディア][6])

### 追加で「仕様として」追記したい点

1. aging が DM 優先を“超える”ことを明記

- `PRIORITY_MAX` は **DM の基礎優先度より必ず高い**、と仕様に1行入れてください。
  - これが無いと「DM優先のまま aging が効かない」実装が出ます。

2. work-conserving の分岐条件を形式化

- 仕様としてはこう書くのが明確です。
  - 非DM待ちが **1件でもある** → `dmRunning < maxRunningDM` を厳格適用（非DM枠確保）
  - 非DM待ちが **0件** → DM が全枠を使って良い（work-conserving）([ウィキペディア][5])

3. 同一優先度の FIFO は現行のまま維持

- 「同一優先度は FIFO」は starvation の温床になりにくく、テストもしやすいので良いです。

---

## 注記

- watermark — ここでは「ログの追い読み位置（scan）」と「対応完了境界（handled）」を分けた永続状態を指します。
- work-conserving — “待っている仕事がある限り、資源を遊ばせない”スケジューラの性質です。([ウィキペディア][5])
- aging — 待ち時間に応じて優先度を上げ、starvation（飢餓）を防ぐ手法です。([ウィキペディア][6])
- `strict: true` — ツール定義（関数定義）スキーマへの一致を強める設定として説明されています。([OpenAI][7])

---

## 見解

この版は、当初の「sessionKey なしグローバル境界」という致命傷を完全に回避できる構造になっています。
残るリスクは実装ブレ由来（`loggedAt` の扱い、`lastGoodOffset` の更新、`PRIORITY_MAX` の定義）なので、ここを **仕様で1段だけ硬く**すれば、MVPとして十分に“壊れにくい”状態です。

---

## 推奨既定値

- `ADJUTANT_GLOBAL_STARVATION_MS=120000`（現行通り、ステップ関数）([GeeksforGeeks][8])
- `PRIORITY_MAX` は DM基礎優先度より大（仕様に明記）
- `loggedAt` は **必須**（timeline行に常に入る）
- Flusher tick 終了時は **`lastScannedOffset = lastGoodOffset`** を原則（末尾不完全行耐性）

---

## 例と反例

### 例

過去ログ（古い `ts`）が起動直後に流入した

- `loggedAt` を stale 判定に使うので、即 stale になって誤発火しにくい（記録時点ベース）。

### 反例

`assistant_aborted` で `lastHandledOffset` を進めてしまう

- 「対応完了ではない」run でも境界が進み、未対応 post を Flusher が二度と拾えない（取りこぼしが恒久化）。

---

## 次アクション

- `TimelineRecordV1_5.loggedAt` を **必須フィールド**として明記し、命名（`loggedAt`/`logged_at`）を統一する
- Flusher の offset 更新規約を「tick終了時は `lastScannedOffset = lastGoodOffset`」で仕様に追記する
- `PRIORITY_MAX > DM base priority` を仕様に追記し、aging が DM 優先を確実に上書きできることを固定する
- `.tmp`→`fs.rename` の前提（同一FS）を仕様の永続化節に1行追記する([The Open Group][2])

[1]: https://docs.slack.dev/reference/objects/conversation-object/?utm_source=chatgpt.com "Conversation object | Slack Developer Docs"
[2]: https://pubs.opengroup.org/onlinepubs/009695399/functions/rename.html?utm_source=chatgpt.com "rename - Open Group"
[3]: https://developers.openai.com/api/docs/guides/function-calling?utm_source=chatgpt.com "Function calling | OpenAI API"
[4]: https://developers.openai.com/api/docs/assistants/tools/function-calling?utm_source=chatgpt.com "Assistants Function Calling - OpenAI API"
[5]: https://en.wikipedia.org/wiki/Work-conserving_scheduler?utm_source=chatgpt.com "Work-conserving scheduler"
[6]: https://en.wikipedia.org/wiki/Aging_%28scheduling%29?utm_source=chatgpt.com "Aging (scheduling)"
[7]: https://openai.com/ja-JP/index/introducing-structured-outputs-in-the-api/?utm_source=chatgpt.com "API に Structured Outputs を導入 - OpenAI"
[8]: https://www.geeksforgeeks.org/operating-systems/starvation-and-aging-in-operating-systems/?utm_source=chatgpt.com "Starvation and Aging in Operating Systems - GeeksforGeeks"
