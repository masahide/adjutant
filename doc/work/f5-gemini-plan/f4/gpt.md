# gpt からのフィードバック

- Claude Codeドラフトは、3点とも**方向性は正しい**です（`sessionKey` 必須化、`assistant_final` 境界、aging など）。
- ただし実装で事故りやすいのは **「境界を `ts` で扱うこと」**と、**DM burst slot が実質 starvation を悪化させる設計**です。
- 提案は、(1) watermark を **scan / handled / open を“offset中心”で定義**、(2) 境界は **`assistant_final` のみで前進**、(3) starvation は **クラス別同時実行上限 + aging（必要ならDRR/Token Bucketへ拡張）**です。 ([マニュアルページ][1])

---

## watermarks.json — スキャン進捗と対応境界を分離する提案

### 状態定義の結論

- **scan** は「`timeline.jsonl` をどこまで読んだか」の I/O 再開点（byte offset）。
- **handled** は「その `sessionKey` がどこまで“対応完了した”か」の意味論境界。
- **境界は `ts` ではなく `offset` を正にする**（遅延到着や“古い `ts` の新規追記”に強い）。

Slack のチャネル種別判定も同様に、ID プレフィクスではなく conversation object の種別フラグ（`is_im`/`is_mpim` 等）を正とする方針でOKです。 ([Slack Developer Docs][2])

### Claude Codeドラフトへの差分提案

ドラフトの `WatermarksV1` は良い骨格です。追加したいのは次の2点です。

1. `sessions[*].handled.lastHandledOffset` を **optional** に（初回は未定義）。
2. `sessions[*].handled.lastHandledTs` を **デバッグ専用**で追加（意味論には使わない）。

さらに、`open.oldestOpenPostTs` の stale 判定に使う `ts` は、可能なら **“記録時刻（logged/recorded）”**を推奨します。理由は、起動直後に過去ログが流入したとき、イベント時刻が古くて即 stale になる誤発火を避けるためです（ここは実データに依存するのでMVPではどちらでもよいが、後から困りやすい）。

### 追い読みスキャンの厳密ルール

- `scan.lastScannedOffset` から追い読み
- 1行ごとに JSON parse 成功したら `scan.lastGoodOffset` を更新
- 末尾不完全で parse 失敗したら **`lastGoodOffset` で止める**（次周期で再試行）
- `fileSize < lastScannedOffset`（truncate復旧など）なら **offset を 0 に戻して全走査**（自己修復）

watermarks の永続化は `.tmp` へ書いて `rename` で差し替え（同一FS内）を必須にすると、途中クラッシュでも「古いか新しいか」の二択に寄せられます。`rename()` が既存ファイルを不可分に置換し得ることは manpage でも説明されています。 ([マニュアルページ][1])

---

## lastHandledTs — 境界イベントを `assistant_final` に固定する提案

### 境界イベント定義の結論

- **境界を進めるのは `actionType="assistant_final"` のみ**。
- `tool` / `tool_result` / `assistant_aborted` / `assistant_error` では **境界を進めない**。
- 境界は **tsではなく “その行頭の byte offset”**を正とする（`lastHandledOffset`）。

### なぜ tool で境界を進めないか

tool 呼び出しは回答生成の途中で起き得るため、そこで境界を進めると **「未返信の user post が“対応済み扱い”」**になり、Flusher が拾えなくなります（取りこぼしが恒久化）。

### timeline 側に入れる action レコードの最低要件

ドラフトの `assistant_final/aborted/error` は良いです。加えて「**1 run につき 1回だけ**」を仕様化してください。

- `assistant_final`: run が **正常終端**（SSEの終端＝final相当）
- `assistant_aborted`: abort（終端＝aborted相当）
- `assistant_error`: 例外（終端＝error相当）

LLMツール強制の方針も妥当です。OpenAIの function calling では `strict: true` の推奨が明記され、また「ツール呼び出しが複数並ぶと strict が崩れる」ため `parallel_tool_calls=false` で 0 or 1 回に制限できる旨が記載されています。 ([OpenAI Developers][3])

---

## グローバル並行制御 — starvation を潰す最小構成の提案

### starvation 対策の結論

優先度キュー + DM優先だけだと starvation が起きます。対策の最小セットは次です。

1. **クラス別同時実行上限（hard cap）**
2. **aging（待ち時間で優先度ブースト）**
3. （可能なら）**起動レート制限（token bucket）**で瞬間スパイク抑制

aging は「待ちすぎたタスクの優先度を徐々に上げて starvation を防ぐ」典型手法です。 ([ウィキペディア][4])

token bucket は「バーストを許しつつ長期平均を抑える」仕組みとして広く使われます。 ([GeeksforGeeks][5])

### Claude Codeドラフトへの具体修正

ドラフトの **DM burst slot (+1)** は、DMを即時にしたい意図は分かりますが、**非DMの starvation を悪化**させ得ます。ここは次のどちらかを推奨します。

#### 推奨案A　burst slot は維持しつつ「DM上限」を入れる

- 総同時実行: `maxConcurrent + dmBurstSlot`（例: 3+1=4）
- **DM同時実行上限**: `maxRunningDM = totalSlots - 1`（例: 3）
  - 非DMが待っている限り、最低1枠はチャンネル等に残す

- aging: `waitMs >= starvationMs` のタスクは **DMより上に来る**ようブースト量を定義

これで「DM即時性」と「チャンネル永久保留」を両立できます。

#### 推奨案B　burst slot をやめて token bucket で DM を“開始優先”にする

- 同時実行は 3 固定
- スケジューラは DM を優先して開始するが、開始頻度を token bucket で制御
- “DMが来たら必ず即時に新規スロット追加”はしない（コストスパイクを避ける）

### 将来拡張　DRRで公平性をO(1)にする

もし “クラス別上限 + aging” でも偏りが残るなら、DRR（Deficit Round Robin）に進めるのが筋です。DRRは公平性を保ちつつ O(1) で回せるスケジューリングとして提案されています。 ([ウィキペディア][6])

---

## 注記

- LLM — Large Language Model。ここでは軽量分類（Route LLM）と重い応答生成（Agent Runner）を区別します。
- offset — `timeline.jsonl` の byte offset（行頭位置）。遅延到着のイベントが“古い ts で新規追記”されても拾えるため、境界に向きます。
- starvation — 高優先度が連続し、低優先度が永久に実行されない現象。aging はこれを防ぐ代表手法です。 ([ウィキペディア][4])

## 見解

- Claude Codeドラフトは、3点の方向性をすでに満たしています。
- ただし実装事故の温床は「境界＝ts」「DM burst slot無制限」「toolで境界前進」の3つです。ここを仕様で禁止・上限化すれば、Flusherが“最後の砦”として確実に機能します。

## 推奨既定値

- watermark
  - `lastHandledOffset` は optional（未定義=0相当）
  - truncate復旧時は `scan` だけでなく `handled/open` も再構築

- 境界イベント
  - `assistant_final` のみ handled 前進

- starvation
  - `starvationMs = 120000`（2分）
  - `totalSlots = maxConcurrent + dmBurstSlot`（例 4）
  - `maxRunningDM = totalSlots - 1`（例 3）
  - token bucket（入れるなら）: `rate=2 starts/sec`, `burst=3` ([GeeksforGeeks][5])

---

## 例と反例

### 例

`assistant_final` の行頭 offset を `lastHandledOffset` に採用すると、**古い `ts` のイベントが後から追記されても**（offsetが境界より後なので）未対応として Flusher が拾える。

### 反例

`tool` を境界にしてしまうと、回答生成途中の tool 実行で handled が進み、未返信の user post が「処理済み扱い」になって Flusher が永久に拾えない。

---

## 次アクション

- `WatermarksV1` を「scan（I/O）／handled（境界）／open（未対応候補）」で**仕様として明記**し、境界は `lastHandledOffset` を正にする
- `assistant_final/aborted/error` の意味を確定し、**handled 前進は `assistant_final` のみ**をテストで保証する
- グローバル並行制御は
  - 最小: **クラス別同時実行上限 + aging**
  - 余裕があれば: **token bucket**（開始頻度制限）
  - 将来: **DRR**（公平性のO(1)化）

- Claude Codeドラフトの DM burst slot は、**`maxRunningDM` を必須化**して starvation を物理的に防ぐ

[1]: https://ja.manpages.org/rename/2?utm_source=chatgpt.com "man rename (2): ファイルの名前や位置を変更する"
[2]: https://docs.slack.dev/reference/objects/conversation-object/?utm_source=chatgpt.com "Conversation object | Slack Developer Docs"
[3]: https://developers.openai.com/api/docs/guides/function-calling?utm_source=chatgpt.com "Function calling | OpenAI API"
[4]: https://en.wikipedia.org/wiki/Aging_%28scheduling%29?utm_source=chatgpt.com "Aging (scheduling) - Wikipedia"
[5]: https://www.geeksforgeeks.org/computer-networks/token-bucket-algorithm/?utm_source=chatgpt.com "Token Bucket Algorithm - GeeksforGeeks"
[6]: https://en.wikipedia.org/wiki/Deficit_round_robin?utm_source=chatgpt.com "Deficit round robin"
