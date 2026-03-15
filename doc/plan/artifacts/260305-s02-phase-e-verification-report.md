# 260305-s02 Phase E Verification Report

## 1. 実施概要

- 実施日: 2026-03-05
- 対象: `260305-s02-phase-e-proactive-heartbeat-reintroduction`
- 目的: Phase E（proactive / watermark-flusher / heartbeat）の受け入れ条件・DoD を最終確認する

## 2. 検証コマンドと結果

1. `pnpm run test -- tests/integration/proactive-ingest-routing.test.ts tests/unit/control-plane/proactive/watermark-store.test.ts`
   - 結果: pass（テストランナー仕様により全件実行、`tests 312 / pass 311 / fail 0 / skipped 1`）
   - 追加検証:
     - `collector burst / DM burst / flusher / heartbeat の同時負荷でも処理できる`
     - `timeline truncate を検知したら scan offset と session 状態を初期化する`
2. `rg -n "console\.log|debugger;|TEMP|tmp-log" src tests doc`
   - 結果: pass（Phase E 追加コードにデバッグ痕跡なし）
3. `rg -n "errorCode|heartbeat.run.completed|flusher.tick.failed|watermark\.warn|timeline\.append\.failed" src/index.ts src/control-plane`
   - 結果: pass（error code / heartbeat reason / flusher-watermark 異常の監査ログ出力点を確認）

## 3. 受け入れ条件トレーサビリティ

1. channel post の attention window 集約 dispatch
   - `tests/unit/control-plane/proactive/ingress-service.test.ts` (`channel は attention window で集約されて 1 dispatch になる`)
2. DM / mention の immediate 処理
   - `tests/unit/control-plane/proactive/rule-triage.test.ts` (`DM は immediate になる`, `mention は immediate になる`)
3. classifier timeout/例外時の fail-closed (`note`)
   - `tests/unit/control-plane/proactive/batch-classifier.test.ts`
   - `tests/contract/proactive/classifier-action-contract.test.ts`
4. terminal action による watermark handled 前進（assistant_final のみ）
   - `tests/unit/control-plane/proactive/watermark-store.test.ts` (`assistant_final のみ handled watermark を前進させる`)
5. stale open post の flusher enqueue と suppression
   - `tests/unit/control-plane/proactive/pending-flusher.test.ts`
6. heartbeat periodic/manual の結果永続化と取得
   - `tests/integration/control-plane-http-sse.test.ts` (`heartbeat API run/last/history と SSE heartbeat event が連動する`)
   - `tests/unit/control-plane/heartbeat/result-store.test.ts`
7. `POST /api/heartbeat/run` の API/SSE 契約
   - `tests/unit/control-plane/http/control-plane-router.test.ts`
   - `tests/contract/http/sse-event-contract.test.ts`

## 4. Phase 4 検証タスク対応

1. `Task-E-VERIFY-002` 同時負荷（collector burst / DM burst / flusher / heartbeat）
   - `tests/integration/proactive-ingest-routing.test.ts` の新規ケースで検証
2. `Task-E-VERIFY-003` truncate / restart / duplicate 通知境界
   - truncate: `tests/unit/control-plane/proactive/watermark-store.test.ts` 新規ケース
   - restart + duplicate: `tests/integration/control-plane-http-sse.test.ts` 既存ケース
3. `Task-E-VERIFY-004` ログ/監査確認（PII・error code・heartbeat reason）
   - 監査ログ契約: `tests/integration/control-plane-http-sse.test.ts` (`agent audit logs run/tool events and run audit API returns summary`)
   - ログ出力点は `src/index.ts` で `errorCode` / `reason` / `sessionKey` までを確認（payload 本文の常時出力なし）
4. `Task-E-VERIFY-005` ドキュメント同期
   - `doc/spec/proactive-routing.md` / `doc/spec/acp-architecture.md` / `doc/spec/storage.md`
   - `doc/file-paths.md`（timeline/watermarks/heartbeat-runs の ACP 実装反映）
   - `doc/runbook/proactive-flusher-operations.md`
   - `doc/runbook/heartbeat-operations.md`
   - `doc/plan/260228-s03-acp-legacy-migration-roadmap-overview.md`（Phase F へ更新）

## 5. 結論

- Phase E の実装・統合・検証は受け入れ条件 1-7 を満たす状態に到達した。
- `proactive` / `watermark+flusher` / `heartbeat` の API・SSE・永続化・再起動境界はテストで固定された。
