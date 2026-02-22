• 指摘事項（重大度順）

1. Medium: WatermarksV1.sessions の無制限増加リスク
   doc/plan/260222-s03-routing-pipeline-v1.5.md:177
   sessionKey を永続的に保持する前提になっており、openPostCount=0 後の削除条件や TTL が定義されていません。運用期間が長い環境では memory/watermarks.json が肥
   大化し、I/O・メモリ効率低下につながる懸念があります。
   最小修正案:

- openPostCount=0 かつ最新位置に追いついたセッションを削除する条件を追記
- または lastAccessAt を持たせ、期限切れ pruning（定期 GC）を仕様化

確認したが追加指摘なし

- 仕様矛盾・定義漏れ
- 障害時リカバリ / 再実行整合性
- テスト観点の不足（この文書のスコープ内）

オープンクエスチョン

1. 想定最大セッション数（チャンネル + DM + スレッド）はどれくらいですか？
2. watermarks の保持期間要件（監査・再処理要件）があるなら、TTL と整合を取る必要があります。
