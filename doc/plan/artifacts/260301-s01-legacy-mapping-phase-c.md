# 260301-s01 Legacy 移植マッピング（Phase C / collector-slack）

- 作成日: 2026-03-03
- 対象計画: `doc/plan/260301-s01-phase-c-collector-slack-migration.md`
- 目的: legacy 実装から Phase C で再配置する責務を追跡可能にし、未移植領域を明確化する

| 移植元 (legacy/impl-20260228/src)                                       | 移植先 (src/\*)                                         | 契約ID           | 差分                                                            | テストID                                                         | 状態        |
| ----------------------------------------------------------------------- | ------------------------------------------------------- | ---------------- | --------------------------------------------------------------- | ---------------------------------------------------------------- | ----------- |
| `core/events.ts`                                                        | `core/events.ts`                                        | C-EVENT-001      | `NormalizedEvent` 共通型を再導入                                | `tests/unit/core/events.test.ts`                                 | Done        |
| `core/validateEvent.ts`                                                 | `core/events.ts` (`isNormalizedEvent`)                  | C-EVENT-002      | 検証関数を共通型ファイルへ集約                                  | `tests/unit/core/events.test.ts`                                 | Done        |
| `slack/normalize.ts`                                                    | `collector-slack/*` (予定)                              | C-COLLECTOR-001  | 正規化ロジック本体は未移植                                      | `Task-CA-RED-002`, `Task-CA-GREEN-002`                           | Not Started |
| `slack/adapter.ts`                                                      | `collector-slack/slack-adapter.ts` (予定)               | C-COLLECTOR-002  | CDP hook + UID 去重の移植待ち                                   | `Task-CA-RED-002`, `Task-CA-GREEN-002`                           | Not Started |
| `slack/domCaptureService.ts`                                            | `collector-slack/dom-capture-service.ts` (予定)         | C-COLLECTOR-003  | reaction 補完の CDP DOM 探索は未移植                            | `Task-CA-RED-003`, `Task-CA-GREEN-003`                           | Not Started |
| `slack/nameCacheRepository.ts`                                          | `collector-slack/slack-name-cache-repository.ts` (予定) | C-COLLECTOR-004  | team 別 cache 永続化は未移植                                    | `Task-CA-RED-004`, `Task-CA-GREEN-003`                           | Not Started |
| `io/jsonlWriter.ts`                                                     | `collector-slack/jsonl-writer.ts` (予定)                | C-COLLECTOR-005  | account/date/source path 解決は未移植                           | `Task-CA-RED-005`, `Task-CA-GREEN-003`                           | Not Started |
| `slack/slackDebug.ts`                                                   | `collector-slack/debug-ui.ts` (予定)                    | C-COLLECTOR-006  | Debug UI /events SSE は未移植                                   | `Task-CA-RED-006`, `Task-CA-GREEN-004`                           | Not Started |
| `proactive/channel-notification-pipeline.ts` (`sessionKey` ルール/文面) | `control-plane/process-rpc/ingest-projection.ts`        | C-PROJECTION-001 | sessionKey と prompt テンプレートを collector ingest 用へ単純化 | `tests/unit/control-plane/process-rpc/ingest-projection.test.ts` | Done        |
| `runtime/slackConnection.ts`                                            | `collector-slack/main.ts` (予定)                        | C-COLLECTOR-007  | 再接続ループ + full jitter は未移植                             | `Task-CA-RED-001`, `Task-CA-GREEN-001`                           | Not Started |

## 補足

- 本マッピングは Stage 1 の契約固定を優先し、collector 本体の実装タスクは未着手として明示した。
- `collector/ingest` 契約は `source=slack` + `payload=NormalizedEvent` に固定済みで、型と contract test に反映済み。
