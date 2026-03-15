# 260305-s03 Phase F 契約凍結（Task-F-000, Task-F-003）

- 作成日: 2026-03-05
- 対象計画: `doc/plan/260305-s03-phase-f-finish-and-stabilization.md`
- 目的: Phase F で「設定整理 / docs 同期 / CI gate / 監査 artifact 形式」を実装前に固定する

## 1. 契約対象の確定（Task-F-000）

### 1.1 設定キー管理の正本

- 正本（source of truth）
  - 実行時の設定実体: `src/**`, `scripts/**` の環境変数参照
  - 棚卸し結果: `doc/plan/artifacts/260305-s03-phase-f-env-inventory.md`
- 同期対象ドキュメント
  - `README.md`: 起動手順と利用者向け設定表
  - `doc/spec/README.md` と配下詳細仕様: 契約・既定値・例外方針
  - `doc/file-paths.md`: 永続化パスと override 可否
- 同期検証の責務
  - 実装側に存在する key が docs で未記載なら fail
  - docs 側のみの key は「docs-only key」として列挙し、Phase 2 で「実装参照追加」または「docs から削除/注記」を選択する

### 1.2 docs 責務分担

| ドキュメント                        | 責務                                               | ここに書かないこと                   |
| ----------------------------------- | -------------------------------------------------- | ------------------------------------ |
| `README.md`                         | 実行に必要な最小設定、主要コマンド、運用上の注意   | 詳細な内部契約、網羅的エラー分類     |
| `doc/spec/README.md` と配下詳細仕様 | API/Process RPC/エラー分類/feature gate の正規契約 | 日々の運用手順、インシデント対応手順 |
| `doc/file-paths.md`                 | ファイル I/O の正本パスと env override             | API 契約、運用フロー詳細             |
| `doc/runbook/*.md`                  | 障害時一次対応、復旧手順、エスカレーション条件     | 型定義や契約の仕様詳細               |

### 1.3 CI gate 方針

- `qa` job は必須（Required）とし、PR マージ条件に固定する
- `live-agent` job は `needs: qa` かつ `OPENAI_API_KEY` secret がある場合のみ実行する
- `live-agent` の fail は原因特定可能な独立ジョブとして扱い、`qa` の成否とは分離する
- Phase F で追加する docs/config 同期検証は `qa` job 内に統合する

## 2. docs と実装の初期差分（Task-F-000 入力）

`README.md` / `doc/spec/configuration.md` / `doc/file-paths.md` と `process.env` 参照の機械比較（prefix: `ADJUTANT_`, `CDP_`, `DATA_DIR`, `OPENAI_API_KEY`, `ACP_ENABLE_LOAD_SESSION`, `ACP_WORKER_*`）で次を確認した。

- docs-only key: 35
- code-only key: 36

代表例（docs-only）:

- `ADJUTANT_API_PORT`, `ADJUTANT_API_HOST`
- `ADJUTANT_CDP_EVENT_LOG`, `ADJUTANT_RAW_FETCH_LOG`
- `ADJUTANT_MEMORY_SEARCH_MODEL`, `ADJUTANT_MEMORY_SEARCH_VECTOR_ENABLED`
- `DATA_DIR`

代表例（code-only）:

- `ADJUTANT_CONTROL_PLANE_HOST`, `ADJUTANT_CONTROL_PLANE_PORT`
- `ADJUTANT_FLUSHER_ENABLED`, `ADJUTANT_HEARTBEAT_ENABLED`
- `ADJUTANT_DELIVER_SLACK_ENABLED`, `ADJUTANT_DELIVER_SLACK_ENTRY`
- `ACP_WORKER_SANDBOX_*`, `ACP_WORKER_SESSION_STORE_PATH`

注記:

- この差分は「`process.env` 直接参照」の抽出結果であり、設定ローダー経由の参照は Phase 2 で catalog 側に吸収する。

## 3. Mermaid と artifact 形式の確定（Task-F-003）

### 3.1 Mermaid 更新ルール

- 正本: `doc/plan/260305-s03-phase-f-finish-and-stabilization.md` の 5.2（クラス図）/5.3（シーケンス図）
- 更新条件:
  - `ConfigCatalogEntry` / `DocSyncViolation` / `MigrationAuditRecord` の項目変更
  - CI gate の依存関係（`qa`, `live-agent`）変更
- 変更時は plan 本文と本 artifact の両方を同時更新する

### 3.2 移植監査 artifact 出力形式

出力先: `doc/plan/artifacts/260305-s03-phase-f-migration-audit.md`

必須列:

| 列名             | 説明                              |
| ---------------- | --------------------------------- |
| `legacyPath`     | 移植元 legacy ファイル/責務       |
| `acpPath`        | ACP 側の実装先                    |
| `phase`          | `A/B/C/D/E`                       |
| `status`         | `done` / `deferred` / `non-scope` |
| `evidence.spec`  | 根拠 spec 章                      |
| `evidence.tests` | 根拠テスト                        |
| `evidence.files` | 根拠実装ファイル                  |
| `note`           | 補足（差分理由、保留理由）        |

### 3.3 検証レポート artifact 出力形式

出力先: `doc/plan/artifacts/260305-s03-phase-f-verification-report.md`

必須セクション:

1. 実施概要（実施日、対象計画、目的）
2. 実行コマンドと結果（pass/fail、補足）
3. 受け入れ条件トレーサビリティ（条件 1-7 と根拠リンク）
4. docs/config 同期差分の結果（mismatch 件数、主な差分）
5. CI gate 検証（`qa` 必須 / `live-agent` 条件実行）
6. 結論（DoD 達成可否、残課題）
