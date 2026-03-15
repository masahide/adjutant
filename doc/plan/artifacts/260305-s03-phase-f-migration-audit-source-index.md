# 260305-s03 Phase F: 移植監査ソース索引（Task-F-002）

- 作成日: 2026-03-05
- 目的: Phase A-E の mapping/report/spec/test 根拠を、Phase F 最終監査表作成の入力として固定する

## 1. フェーズ別ソース一覧

| Phase | 計画書                                                                       | 主要 artifact                                                                                                                                                                      | spec 根拠章                                                                                                            | テスト根拠（代表）                                                                                                                                                            |
| ----- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A/B   | `doc/plan/implemented/260228-s04-phase-a-b-pi-agent-webui-memory-sandbox.md` | `doc/plan/artifacts/260228-s04-legacy-mapping.md`<br>`doc/plan/artifacts/260228-s04-interface-contract-freeze.md`<br>`doc/plan/artifacts/260228-s04-stage4-verification-report.md` | `doc/spec/acp-architecture.md`                                                                                         | `tests/integration/control-plane-http-sse.test.ts`<br>`tests/integration/phase-b-memory-sandbox-audit.test.ts`<br>`tests/contract/process-rpc/process-rpc-validation.test.ts` |
| C     | `doc/plan/260301-s01-phase-c-collector-slack-migration.md`                   | `doc/plan/artifacts/260301-s01-legacy-mapping-phase-c.md`                                                                                                                          | `doc/spec/data-model.md`<br>`doc/spec/collector-runtime.md`<br>`doc/spec/acp-architecture.md`<br>`doc/spec/storage.md` | `tests/integration/collector-slack/*`<br>`tests/unit/collector-slack/*`                                                                                                       |
| D     | `doc/plan/260304-s01-phase-d-queue-recovery-hardening.md`                    | `doc/plan/artifacts/260305-s01-phase-d-verification-report.md`                                                                                                                     | `doc/spec/acp-architecture.md`<br>`doc/spec/storage.md`                                                                | `tests/integration/acp-recovery.test.ts`<br>`tests/integration/acp-deliver-completion-idempotency.test.ts`<br>`tests/integration/deliver-enqueue-completion-flow.test.ts`     |
| E     | `doc/plan/260305-s02-phase-e-proactive-heartbeat-reintroduction.md`          | `doc/plan/artifacts/260305-s02-phase-e-legacy-mapping.md`<br>`doc/plan/artifacts/260305-s02-phase-e-verification-report.md`                                                        | `doc/spec/proactive-routing.md`<br>`doc/spec/acp-architecture.md`<br>`doc/spec/storage.md`                             | `tests/integration/proactive-ingest-routing.test.ts`<br>`tests/integration/control-plane-http-sse.test.ts`<br>`tests/unit/control-plane/proactive/*`                          |

## 2. Phase F 監査での status 判定ルール

- `done`
  - 実装ファイルが現行 tree に存在し、対応する unit/integration/contract の少なくとも 1 つで根拠がある
- `deferred`
  - 計画書または spec の「未実装」「後続対応」で明示され、代替運用（runbook/feature flag）が存在する
- `non-scope`
  - ロードマップまたは Phase 計画で明示的に非スコープと定義されている

## 3. 監査レコード最小単位

最終 artifact（`260305-s03-phase-f-migration-audit.md`）は以下単位で作成する。

- 1 レコード = 「legacy 側の 1 責務」
- `legacyPath` はファイル単位を基本とし、必要に応じて責務名を suffix で補足する
- `acpPath` は複数可（`,` 区切りまたは改行）
- 各レコードに `evidence.spec / evidence.tests / evidence.files` を最低 1 件ずつ付与する

## 4. 既知ギャップ（Phase F で要判断）

- Phase C artifact は planning 時点の `Not Started` が残っているため、現行実装との再照合が必要
- docs とコードの env key 差分が多く、監査時に「仕様上有効だが直接参照で拾えない key」を区別する必要がある
- `doc/spec/feature-catalog.md` の未実装項目を `deferred` へどの粒度でマッピングするかを最終決定する必要がある
