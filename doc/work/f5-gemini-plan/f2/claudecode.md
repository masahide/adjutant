⏺ Gemini の最終案を精読しました。全体として議論の合意を正確に反映しており、実装着手可能な品質です。

ただし 前ターンで私が指摘した3点のうち2点が反映されていない ので、最終確認として挙げます。

---

反映済み（問題なし）

- 層0 の ID プレフィクス依存排除（conversations.view の channel type を正とする）
- POLICY_ROUTING.json の分離（GPT 側の立場を受入れ。アーキテクチャ的に安全）
- Watermark の atomic write + truncate 復旧
- Flusher のトリアージ LLM 不採用（MVP）

未反映（補足が必要な2点）

1. DM の並行キュー例外枠

前ターンで指摘した「maxConcurrent=3 が全て埋まっている状態で DM が来た場合」の挙動が最終案に入っていない。

層3 の仕様に以下を追記すべき:

DM/@メンションは maxConcurrent の制限外として +1 スロットを許可する。実効上限は maxConcurrent + 1 = 4。これにより、チャンネル処理中でも DM
の即時性が保証される。

2. 設計検証のモニタリング指標

前ターンで提案した4つのメトリクス（route_llm_calls_per_hour, flusher_fire_count, agent_invocations_by_source,
event_to_response_p95_ms）が最終案に含まれていない。

これは「設計が正しく機能しているか」を判断する唯一の手段なので、仕様に含めるべき。特に flusher_fire_count は「Flusher にトリアージ LLM
を追加すべきか」の判断材料になる。

---

パラメータ変更への見解

Gemini が idleMs=3000ms / maxWaitMs=30000ms に変更している（私の提案は 5000ms/60000ms）。

- idleMs=3s: GPT の 2-3s と私の 5s の中間。受入れ可能。
- maxWaitMs=30s: 私と GPT は 60s で合意していたが、30s は「活発なチャンネルでの反応速度」を優先した判断。アクティブチャンネル10個で毎分20回の Route LLM
  呼び出しになるが、gpt-4o-mini のコスト（$0.01/日程度）を考えれば許容範囲。受入れる。

---

結論

上記2点（DM 例外枠 + モニタリング指標）を追記すれば、この最終案で実装に進んでよい。

実装の着手順は Gemini の提案通り、データモデル（timeline.jsonl の sessionKey + watermarks.json）が最優先。他の全層がこれに依存する。

次のステップとして、この最終設計を doc/plan/ 配下の計画書として書き起こすか。それとも doc/spec-unified.md を直接改訂するか。どちらにするか指示をください。
