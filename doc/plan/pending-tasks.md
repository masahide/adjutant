# 残タスク一覧（未実装 / Pending）

- 生成日: 2026-02-20
- 抽出条件: Markdown チェック項目 `- [ ]`
- 対象: `doc/plan/*.md`, `doc/plan/implemented/*.md`（`pending-tasks.md` 自身は除外）

## A. 未移動プラン（未着手）

A 合計: 0件

## B. 実装済みプラン内の未完了項目

### `doc/plan/implemented/260211-s01-slack-adapter-refactor-tdd.md`（3件）

- [ ] (doc/plan/implemented/260211-s01-slack-adapter-refactor-tdd.md:263) 受け入れ条件がすべて満たされていること
- [ ] (doc/plan/implemented/260211-s01-slack-adapter-refactor-tdd.md:264) 既知の制約が明文化され、想定通りであること
- [ ] (doc/plan/implemented/260211-s01-slack-adapter-refactor-tdd.md:265) 契約の例に対して期待通りの結果が得られること

### `doc/plan/implemented/260214-s01-ai-assistant-mvp.md`（14件）

- [ ] (doc/plan/implemented/260214-s01-ai-assistant-mvp.md:1279) Integration: AgentRunner + TranscriptReader + MemoryWriter 結合テスト
- [ ] (doc/plan/implemented/260214-s01-ai-assistant-mvp.md:1301) [MVP+ 任意] セッション切り替え UI
- [ ] (doc/plan/implemented/260214-s01-ai-assistant-mvp.md:1306) 全テスト実行 (`pnpm run check`)
- [ ] (doc/plan/implemented/260214-s01-ai-assistant-mvp.md:1307) JSONL 収集プロセスとの並行動作確認
- [ ] (doc/plan/implemented/260214-s01-ai-assistant-mvp.md:1308) ハートビート E2E 動作確認（HEARTBEAT_OK 抑制、アラート表示）
- [ ] (doc/plan/implemented/260214-s01-ai-assistant-mvp.md:1309) メモリ読み書きの E2E 確認
- [ ] (doc/plan/implemented/260214-s01-ai-assistant-mvp.md:1310) セッション永続化と復元の E2E 確認
- [ ] (doc/plan/implemented/260214-s01-ai-assistant-mvp.md:1311) ドキュメント更新（README, CLAUDE.md）
- [ ] (doc/plan/implemented/260214-s01-ai-assistant-mvp.md:1320) AC-02: AI 応答に JSONL 由来コンテキストが取り込まれる
- [ ] (doc/plan/implemented/260214-s01-ai-assistant-mvp.md:1330) AC-12: `assistant/prompts/SOUL.md` が通常対話/Heartbeat の応答方針に反映される
- [ ] (doc/plan/implemented/260214-s01-ai-assistant-mvp.md:1333) AC-15: 通常対話/Heartbeat の両方で `MEMORY.md` と当日・前日メモを参照する
- [ ] (doc/plan/implemented/260214-s01-ai-assistant-mvp.md:1335) AC-17: セッショントランスクリプト直近窓が入力へ取り込まれる
- [ ] (doc/plan/implemented/260214-s01-ai-assistant-mvp.md:1346) P-02: 全テストがパスし `pnpm run check` が成功する
- [ ] (doc/plan/implemented/260214-s01-ai-assistant-mvp.md:1347) 既存の Slack 収集パイプラインに影響がない

### `doc/plan/implemented/260215-s06-main-integration.md`（1件）

- [ ] (doc/plan/implemented/260215-s06-main-integration.md:16) `pnpm run check` 全体通過

### `doc/plan/implemented/260217-s01-openclaw-proactive-gateway-integration.md`（5件）

- [ ] (doc/plan/implemented/260217-s01-openclaw-proactive-gateway-integration.md:428) 受け入れ条件 11 件がすべて満たされる。
- [ ] (doc/plan/implemented/260217-s01-openclaw-proactive-gateway-integration.md:429) RouteDecision の違法状態が validator とテストで防止される。
- [ ] (doc/plan/implemented/260217-s01-openclaw-proactive-gateway-integration.md:430) 二重追記失敗時の回復が `uid` idempotent で実証される。
- [ ] (doc/plan/implemented/260217-s01-openclaw-proactive-gateway-integration.md:432) spoke セッションで MEMORY ロード禁止が守られる。
- [ ] (doc/plan/implemented/260217-s01-openclaw-proactive-gateway-integration.md:438) queue overflow timeout self判定不可のログが期待どおり出る。

B 合計: 23件

## C. 独自要件: 軽量LLM一次判定 実装タスク

- [x] `TriggerFilter` の二次判定に軽量LLMクライアントを実装し、`RouteDecision`（run/pending/system/drop）へ正規化する。  
       参照: `doc/reference/openclaw/slack-proactive.md:21`, `src/proactive/trigger-filter.ts`
- [x] 一次判定プロンプト（即時対応要否判定）と出力スキーマを定義し、timeout・不正応答時は deterministic 判定へフォールバックする。  
       参照: `doc/reference/openclaw/slack-proactive.md:21`, `doc/plan/implemented/260217-s01-openclaw-proactive-gateway-integration.md:212`
- [x] `maxConcurrentRouteLlm` と `routeLlmTimeoutMs` を設定値として確定し、環境変数/設定ファイルから注入可能にする。  
       参照: `doc/plan/implemented/260217-s01-openclaw-proactive-gateway-integration.md:456`
- [x] `ChannelNotificationPipeline` で `triggerFilter` を必須配線にし、main セッションへ直接流す経路を判定経由へ統一する。  
       参照: `src/proactive/channel-notification-pipeline.ts`, `src/assistant/main.ts`
- [x] 軽量LLM呼び出しの監査ログ（判定結果・timeout・fallback理由）を追加し、運用時に追跡可能にする。  
       参照: `doc/reference/openclaw/slack-proactive.md:21`, `src/proactive`
- [x] テストを追加する（正常系/timeout/LLM失敗/fallback/並列上限/本文あり通知の判定反映）。  
       参照: `tests/proactive/trigger-filter.test.ts`, `tests/proactive/channel-notification-pipeline.test.ts`

C 合計: 0件（完了）

## 総計

- 未完了項目合計: 23件（A: 0件, B: 23件, C: 0件）
