# claudecodeのフィードバック

⏺ Gemini の修正案を確認しました。前ターンで指摘した2点（DM 例外枠 + モニタリング指標）が反映されており、全体の品質は高い。

1点だけ、MVP として過剰な設計がある。

---

層3 の並行制御が過剰

Gemini は Token Bucket + DRR (Deficit Round Robin) + Aging の3機構を提案しているが、Adjutant
は単一ユーザーのパーソナルアシスタントであり、同時アクティブセッション数は現実的に 3-5 個程度。

この規模に対して DRR（クラス別重み付きラウンドロビン）は明らかにオーバーエンジニアリング。

MVP で十分な設計:

type GlobalConcurrencyQueue = {
maxConcurrent: 3;
dmBurstSlot: 1; // DM専用追加枠
starvationMs: 120_000; // 2分超で優先度昇格

    // 単純な優先度キュー（ヒープ）
    // priority: DM=0 > Group=1 > Channel=2 > Flusher=3 > Heartbeat=4
    // 同一優先度はFIFO

};

Token Bucket と DRR は「数百セッションが同時にイベントを発火する」スケールで必要になる。単一ユーザーでは 優先度付きキュー + maxConcurrent + aging
の3点で十分。将来マルチユーザー化する段階で DRR を検討すればよい。

---

その他の確認事項

assistant_final の書き込み保証

層4 で「actionType="assistant_final" のみを境界とする」設計は明確で良い。ただし、エージェント実行が異常終了した場合にも assistant_final
が書き込まれるかを実装で保証する必要がある。finally ブロックで書き込むか、タイムアウト後に補完するか。書き込まれなければそのセッションの watermark
が永久に進まない。

旧レコードとの互換

adjutant.timeline.record.v1.5 スキーマは現行レコード（スキーマフィールドなし）と混在する。Flusher は sessionKey
がないレコードを「対象外として安全に無視」する旨は記載済みだが、旧レコードの role="assistant"
は境界として扱わないことを明記すべき。そうしないと旧ロジックと新ロジックが混在して判定が不安定になる。

---

結論

層3 の並行制御を優先度キューに簡素化すれば、この仕様で実装に進んでよい。

次のアクションとして、この最終設計を doc/plan/ 配下の計画書として書き起こすのが適切だと考える。理由:

- doc/spec-unified.md の直接改訂は差分が大きすぎて可読性を損なう
- 計画書として独立させ、実装完了後に spec を更新する方が安全
- CLAUDE.md の規約（doc/plan/YYMMDD-s{連番}-{実装名}.md）に従う

計画書の作成に進むか、あるいは先に GPT/Gemini への最終確認を挟むか。指示をください。
