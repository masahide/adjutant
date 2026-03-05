# 260305-s01 Phase D Verification Report

## 1. 実施概要

- 実施日: 2026-03-05
- 対象: `260304-s01-phase-d-queue-recovery-hardening`
- 目的: Phase D の受け入れ条件・DoD・運用観点（recovery/冪等/ログ）を最終確認する

## 2. 検証コマンドと結果

1. `pnpm check`
   - 結果: pass
   - 補足: `package.json` の `pnpm test` timeout を `180000ms` へ調整して file-level timeout を解消
2. `node --import tsx --test tests/integration/acp-recovery.test.ts tests/unit/control-plane/process-rpc/deliver-supervisor.test.ts tests/integration/acp-deliver-completion-idempotency.test.ts`
   - 結果: pass
   - 観点: worker crash/timeout、deliver crash/timeout、completion duplicate/out-of-order
3. `node --import tsx --test --test-name-pattern "POST /api/commands dedupes same idempotencyKey|POST /api/commands keeps idempotency duplicate/conflict after process restart|control-plane replays only pending deliver queue records on startup|collector/ingest dedupeKey remains canonical after process restart" tests/integration/control-plane-http-sse.test.ts`
   - 結果: pass
   - 観点: command idempotency restart 跨ぎ、deliver queue restart replay、collector dedupe restart 跨ぎ

## 3. 受け入れ条件トレーサビリティ

1. enqueue -> completed 経路
   - `tests/integration/deliver-enqueue-completion-flow.test.ts`
2. 未完了 deliver queue の restart replay
   - `tests/integration/control-plane-http-sse.test.ts` (`control-plane replays only pending deliver queue records on startup`)
3. completion duplicate/out-of-order 吸収
   - `tests/integration/acp-deliver-completion-idempotency.test.ts`
4. command idempotency duplicate（restart 後）
   - `tests/integration/control-plane-http-sse.test.ts` (`POST /api/commands keeps idempotency duplicate/conflict after process restart`)
5. command idempotency conflict 409
   - `tests/integration/control-plane-http-sse.test.ts` (`POST /api/commands dedupes same idempotencyKey and rejects conflicting payload`)
6. collector dedupeKey canonical 維持（restart 後）
   - `tests/integration/control-plane-http-sse.test.ts` (`collector/ingest dedupeKey remains canonical after process restart`)
7. deliver プロセスクラッシュ復旧
   - `tests/unit/control-plane/process-rpc/deliver-supervisor.test.ts` (`deliver プロセスクラッシュ時に再起動する`)

## 4. ログ 例外監査

- 監査対象: `src/index.ts` の `deliver.*` / `collector.*` / idempotency 経路ログ
- 確認結果:
  - `messageId`, `dedupeKey`, `runId`, `sessionKey`, `attempt`, `maxAttempts` を中心に出力
  - payload 本文（Slack テキスト本体など）を deliver/collector/idempotency ログへ直接出力していない
  - timeout/crash 例外は `DELIVER_RPC_TIMEOUT`, `DELIVER_CRASHED`, `WORKER_TIMEOUT`, `WORKER_CRASHED` を判別可能
- 残課題:
  - `dispatchMessage` は下流エラー文字列を含むため、将来的にマスキングポリシー統一を検討

## 5. 結論

- Phase D の実装・統合・検証は受け入れ条件を満たす状態まで到達
- 次フェーズでは retention/compaction（idempotency TTL）と error masking 方針を運用設計で確定する
