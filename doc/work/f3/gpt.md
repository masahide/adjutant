# GPTからのフィードバック

要約

- **グローバル境界 + `sessionKey` 欠落**は致命傷で、Heartbeat の「取りこぼし防止」という目的を満たしません。**タイムラインに `sessionKey` を必須化し、境界（watermark）も `sessionKey` 単位**に直すのが最優先です。 ([Slack Developer Docs][1])
- **claudecode の統合案（会話塊→バッチ分類→救済）**は筋が良い一方、**遅延上限・永続化・メモリ権限分離・構造化出力**を仕様に落とす必要があります。 ([GitHub][2])
- **Gemini の v1.5 案**は方向性は合うが、(1) “resolved_by_human” を **確定判定にしない**、(2) **Deep Heartbeat の空回り**、(3) **再起動後の due 復元**が詰めどころです。 ([Taylor & Francis Online][3])

---

## 統合タイムライン境界 — `sessionKey` 必須化と `sessionKey` 別 watermark が最優先

### 反証できない点

claudecode の指摘どおり、**境界がグローバル**だと「セッションAのassistant応答がセッションBの未対応を隠す」ので、Heartbeat の設計目的に反します（取りこぼし防止が破綻）。
Slack 側でもイベント配送は best-effort で遅延し得る前提があるため、**“いつか拾える” の保証は設計側で作る**必要があります。 ([Slack Developer Docs][1])

### 仕様修正案（最小）

`memory/timeline.jsonl` の **全レコード**に以下を追加して固定化します。

- `sessionKey: string`（必須）
- `threadTs?: string`（スレッド単位救済をしたいなら推奨）
- `accountId?: string`（マルチアカウントをやるなら推奨）

そして Heartbeat/Flusher の境界は必ず **(sessionKey, threadTs?) ごと**に計算します。

### 実装上の要点（O(1)に近づける）

逆走査のたびに巨大 JSONL を毎回スキャンすると重いので、**`sessionKey` ごとの watermark を別ファイルで保持**します（JSONLでもSQLiteでも可）。

- watermark 例: `{ sessionKey, lastHandledTs, lastHandledOffset }`
- 「assistant/tool/action を見たら止める」ではなく、「**その sessionKey の lastHandled 以降だけ見る**」に変える

---

## claudecode 統合案 — 採用価値は高いが 4 つの穴を塞ぐ必要がある

ここは **claudecode案**への反証・追加改善です。

### 1) アテンションウィンドウ — “会話の切れ目待ち”に上限がないと無限待機する

**疑問（claudecode案宛）**: 「会話継続中なら次サイクルまで待機」だけだと、活発なチャンネルで **永遠に反応しない**可能性があります。
**改善**: `idleMs`（沈黙閾値）に加えて `maxWaitMs`（最大待機）を入れて、必ずフラッシュします。

- `idleMs`: 2–5秒（会話の切れ目）
- `maxWaitMs`: 30–90秒（長話でも1回は反応）

### 2) DM 即時性 — “0ms”でも micro-batch は入れられる

claudecode が Gemini を反証した「DMに 2–3秒は不要」はその通りです。
ただし **DMはデバウンス無し**だと「分割送信（1文を複数投稿）」で **重エージェント起動が連発**し得ます。

**改善**: DM/メンションは `idleMs=150–300ms` の **micro-batch**で十分です（体感即時を崩さず、分割投稿を1回にまとめられる）。

### 3) メモリ権限分離 — spoke セッションで `MEMORY.md` を見る設計は仕様違反になり得る

claudecode 統合案の「バッチ分類の入力に `MEMORY.md`（ユーザー優先度）を入れる」は、現仕様の **spoke セッションのメモリ遮断**と衝突しやすいです（漏洩回避が目的）。
この分離方針自体は妥当です。

**改善**: spoke で参照してよいのは「個人メモ」ではなく、**通知ポリシーだけ**です。

- 例: `POLICY_ROUTING.json`（チャンネル優先度、静穏時間、上限など）を別管理
- `MEMORY.md` は main 専用のまま

### 4) 構造化出力 — SDK制約があるなら “ツール呼び出し”で代替する

claudecode が言う通り、pi-coding-agent SDK が OpenAI の **strict JSON Schema**をそのまま使えない可能性は現実的です（SDKが抽象化しているため）。一方、OpenAI は Structured Outputs を **Function Calling（ツール呼び出し）**で提供しているので、アーキテクチャとしては「ツールに寄せる」が堅いです。 ([OpenAI][4])

**改善（SDK互換）**:

- `report_route_decision({action, urgency, reason})`
- `report_heartbeat_status({status, reason, notify, payload?})`
  のような “必須ツール” を定義し、**呼ばれなければ run を失敗扱い**にする（文字列マッチ廃止）。

---

## Gemini v1.5 案 — 正しいが「確定判定」と「再起動耐性」を詰めないと危うい

ここは **Gemini案**への反証・追加改善です。

### 1) `resolved_by_human` — 確定判定にすると誤検知コストが高い

「人間が解決済み」検出は、Slack文化差が大きく、✅リアクション等も意味が揺れます。
よって **LLMなし確定判定**も **LLMで確定判定**も危険で、設計としては **“抑制の根拠（弱いシグナル）”に留める**のが安全です。通知疲れは一度起こすと戻りにくいので、誤介入のコストは高く見積もるべきです。 ([ガーディアン][5])

**改善**: `resolved_by_human` は最終結論ではなく

- `urgency` を下げる
- `dueAt` を延ばす
- `notify=false` に寄せる
  などの “抑制バイアス” として使う。

### 2) 動的スケジューリング — 1スレッド1タイマーは避ける

Gemini の「pending発生から15分後に専用チェック」は、claudecode の反証どおり **キャンセル/集中/再起動復元**が重い。
**改善**: “タイマーを増やさず due を守る”なら、以下が現実解です。

- **単一のスケジューラ**（1秒/5秒tick）
- 永続化された `dueAt` の最小ヒープ（SQLiteでもJSONLでも）
- 起動時に復元して再開

---

## コストモデル — ルータ最適化より「重エージェント起動回数」が支配的

claudecode の主張（重い起動が支配的）は妥当です。
ただし、**“会話塊単位にする”**と Route LLM 呼び出しも同時に減るため、最終的には両方効きます（カスケード設計の基本は「難しいときだけ上位へ」）。 ([arXiv][6])

---

## 他エージェント宛の質問案 — 次ターンで潰すと前に進む論点

### Gemini 宛の質問

1. **DM 即時性**: DM/メンションは `idleMs=200ms` の micro-batch でまとめる案をどう扱う？「2–3秒一律デバウンス」は撤回する？
2. **再起動耐性**: `soon`/`dueAt` を再起動後も守るなら、どこに永続化する設計を推す？
3. **resolved_by_human**: 確定判定ではなく “抑制シグナル” に格下げするのは受け入れ可能？

### claudecode 宛の質問

1. **maxWaitMs**: 会話が止まらないチャンネルでの無限待機を避ける最大待機はどう設計する？
2. **spoke のメモリ遮断**: バッチ分類入力に `MEMORY.md` を入れない代替（通知ポリシー専用ファイルなど）は？
3. **Pending Flusher**: 未処理があったら即フルエージェント起動だと5分周期が重くなる。Flusher側にも軽量トリアージを入れる？

### （参考として）GPT 宛の質問

1. kNN ルーティングは今すぐ要る？MVPでは feature-based scoring（キーワード/メンション/疑問符）で十分では？（段階導入案にする）
2. `system-event-queue` 上限20件で `note` が溢れる場合、永続化（timeline action）へ逃がす設計にする？

---

## 注記

- デバウンス — 「短時間の連続入力をまとめる待機」。ここでは **micro-batch（200ms級）**と **会話塊（数秒〜最大90秒）**を区別。
- Structured Outputs — OpenAI APIでは JSON Schema 厳密一致を提供するが、SDK抽象化がある場合は **ツール呼び出し**で同等の堅牢性を作るのが現実的です。 ([OpenAI][4])
- 通知疲れ — 通知が多いと無効化・離脱が増えるという傾向が報告されています。 ([ガーディアン][5])

## 見解

- 今回の争点は「分類精度」より **作業単位（イベント→会話塊）**と **境界の正しさ（sessionKey）**です。
- 2段階（軽量→重い）は続ける価値がありますが、成功条件は「**会話塊で1回だけ起動**」「**fail-closed（保留優先）**」「**救済はsessionKey別**」です。 ([arXiv][6])

## 推奨既定値

- `dmMicroBatchIdleMs`: `200`
- `channelIdleMs`: `3000`
- `maxWaitMs`: `60000`
- `pendingFlushIntervalMs`: `300000`（5分）
- `routeConfidenceThreshold`: `0.7`（未満は保留）
- `notifyBudget`: 「1時間あたり最大N回」「同一話題クールダウン」導入（Nは実測で決める） ([ガーディアン][5])

---

## 例と反例

### 例

- 3分で5投稿のスレッド：`idleMs=3s` で会話塊化 → 1回だけバッチ分類 → `note` なら system-event、`respond` なら1回だけ重エージェント起動。

### 反例

- 10分間ずっと会話が流れ続けるチャンネル：`idleMs`だけだと永遠に反応しない → `maxWaitMs=60s` で強制フラッシュして「要点だけ」対応。

---

## 次アクション

- `timeline.jsonl` に **`sessionKey` を必須追加**し、Heartbeat/Flusher の境界を **sessionKey別 watermark**に置換する
- claudecode 統合案に **`maxWaitMs` と DM micro-batch**を追加して「遅延」と「連発起動」を同時に潰す
- spoke セッション用に `MEMORY.md` とは別の **通知ポリシーファイル**を設計する
- `HEARTBEAT_OK` 文字列マッチを廃止し、**必須ツール呼び出し**で状態報告に統一する ([OpenAI][4])

* [ガーディアン](https://www.theguardian.com/media/2025/jun/20/increase-alert-fatigue-phone-users-disable-news-notifications-study-finds?utm_source=chatgpt.com)
* [axios.com](https://www.axios.com/newsletters/axios-media-trends-20f067c0-502a-11f0-9079-cb3e3eb54f52?utm_source=chatgpt.com)

[1]: https://docs.slack.dev/apis/events-api/?utm_source=chatgpt.com "The Events API | Slack Developer Docs"
[2]: https://github.com/badlogic/pi-mono?utm_source=chatgpt.com "GitHub - badlogic/pi-mono: AI agent toolkit: coding agent CLI ..."
[3]: https://www.tandfonline.com/doi/pdf/10.1080/15213269.2024.2334025?utm_source=chatgpt.com "Beyond the Buzz: Investigating the Effects of a Notification ..."
[4]: https://openai.com/ja-JP/index/introducing-structured-outputs-in-the-api/?utm_source=chatgpt.com "API に Structured Outputs を導入 - OpenAI"
[5]: https://www.theguardian.com/media/2025/jun/20/increase-alert-fatigue-phone-users-disable-news-notifications-study-finds?utm_source=chatgpt.com "Rise in 'alert fatigue' risks phone users disabling news notifications, study finds"
[6]: https://arxiv.org/html/2410.08014v1?utm_source=chatgpt.com "LLM Cascade with Multi-Objective Optimal Consideration"
