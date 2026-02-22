# geminiの回答

Claude CodeとGPT、両エージェントからの最終フィードバックを確認しました。

両者の視点の違いが、MVPにおける「エンジニアリングの現実（コストとスケール）」と「分散システムの理想（堅牢性と正確性）」の完璧なバランスをもたらしてくれました。結論として、**両者の最も優れた提案をマージし、オーバーエンジニアリングを削ぎ落とした最終形態**で合意とします。

---

### 1. Claude Codeへの回答と賛同（MVPの現実的スコープ）

**① 層3のオーバーエンジニアリング指摘について（大賛成）**
ご指摘の通り、単一ユーザーのMVPに対して、DRR（重み付きラウンドロビン）やToken Bucketをフルスクラッチで実装するのは明らかに過剰でした。複雑なスケジューラはバグの温床になります。
実装はご提案の通り、**「単純な優先度キュー（Priority Queue） ＋ DM例外枠（Burst Slot: 1） ＋ エージング（StarvationTimeout）」** に簡素化します。これなら実装も容易で、必要十分なスループットと即時性を担保できます。

**② 計画書（`doc/plan/`）への分離について（賛同）**
プロジェクトの規約（`CLAUDE.md`）と可読性を優先し、`doc/spec-unified.md` を直接書き換えるのではなく、まずは `doc/plan/YYMMDD-s{連番}-routing-v1.5.md` として計画書を作成するアプローチに賛同します。

**③ `assistant_final` の書き込み保証と後方互換性**
これも極めて重要な視点です。実装計画において「try-finallyブロックでの確実な終端レコード書き込み」と「旧レコードの `role="assistant"` は境界として無視する」旨を明記します。

---

### 2. GPTへの回答と賛同（分散システムの堅牢性）

**① `lastHandledTs` ではなく `lastHandledOffset` を境界とする（大賛成・採用）**
これは目から鱗の指摘でした。Slackのイベントはネットワークの都合で**順序が前後して（遅れて）到着する可能性**があります。もしタイムスタンプ（`ts`）を境界にしてしまうと、「過去のタイムスタンプを持つ遅延イベント」が境界の過去側に配置され、永久にFlusherから無視される（取りこぼす）という最悪のバグを生みます。
対応境界は「ログのどの地点（Byte Offset）でエージェントが最終判断を下したか」を表す **`lastHandledOffset`** を正とします。

**② `assistant_aborted` / `assistant_error` の追加（採用）**
Claude Codeの懸念（異常終了時の書き込み保証）を美しく解決する提案です。エージェントの実行終了時は必ず `final`, `aborted`, `error` のいずれかを `timeline.jsonl` に書き込みます。ただし、**`lastHandledOffset` を前進させるのは `assistant_final` だけ**とします（エラー時は未対応のままなので、Flusherに再回収させるため）。

**③ 並行制御（DRR等）について（一部棄却）**
前述の通り、理論上はGPTの提案（DRR + Token Bucket + maxRunning）が最も堅牢ですが、MVP（同時アクティブ3〜5セッション）においてはコードの複雑さがメリットを上回ります。今回はClaude Code提案の「優先度キュー ＋ エージング」に留め、マルチユーザー化の際に再検討させてください。

---

### 3. 最終的な合意事項のまとめ

- **境界管理:** `memory/watermarks.json` にて、I/O進捗は `lastScannedOffset`、セマンティクス対応境界は **`lastHandledOffset`** で管理する。
- **境界イベント:** `timeline.jsonl` に `actionType="assistant_final" | "aborted" | "error"` を記録し、`final` のみ境界を進める。旧レコードの `role="assistant"` は境界として扱わない。
- **グローバル並行制御:** `maxConcurrent=3`、`dmBurstSlot=1`（DM例外枠）、`starvationMs=120000`（2分で優先度昇格）を持つ**シンプルな優先度キュー**を採用する。
- **メトリクス:** `route_llm_calls_per_hour`, `flusher_fire_count`, `agent_invocations_by_source`, `event_to_response_p95_ms` を必須監視項目とする。

### 次のアクション

すべての死角が埋まりました。実装計画に落とし込む準備が完全に整っています。

**Claude Code へのお願い：**
上記の最終合意（`lastHandledOffset` の採用や、単純化された優先度キュー、モニタリング指標など）をすべて含めた形で、**`doc/plan/` 配下に v1.5 ルーティング＆状態管理の実装計画書（Markdown）** をドラフト生成してもらえますか？
