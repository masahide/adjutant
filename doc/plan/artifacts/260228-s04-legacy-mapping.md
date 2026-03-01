# 260228-s04 Legacy 移植マッピング

- 作成日: 2026-02-28
- 対象計画: `doc/plan/260228-s04-phase-a-b-pi-agent-webui-memory-sandbox.md`
- 目的: Phase A/B で移植する責務を、legacy 実装から現行 ACP 構成へ 1:1 で追跡可能にする

| 移植元 (legacy/impl-20260228/src)                        | 移植先 (src/\*)                                      | 契約ID                  | 差分                                                     | テストID                             | 状態        |
| -------------------------------------------------------- | ---------------------------------------------------- | ----------------------- | -------------------------------------------------------- | ------------------------------------ | ----------- |
| `assistant/agent-runner.ts`                              | `assistant/agent-runner.ts`                          | ACP-SESSION-PROMPT-001  | 現在は prompt echo。`pi-coding-agent` 実接続へ置換が必要 | `Task-A-RED-002`, `Task-A-GREEN-003` | In Progress |
| `assistant/agent-session-factory.ts`                     | `assistant/agent-session-factory.ts` (新規)          | ACP-SESSION-INIT-001    | factory 未移植                                           | `Task-A-GREEN-002`                   | Not Started |
| `assistant/agent-event-subscriber.ts`                    | `agent-worker-acp/session-update-projector.ts` ほか  | ACP-STREAM-001          | update 変換を ACP 命名へ統一                             | `Task-A-INTEG-002`                   | In Progress |
| `assistant/session-persistence.ts`                       | `control-plane/acp/session-recovery-store.ts` (新規) | ACP-SESSION-LOAD-001    | recovery 永続化実体が未実装                              | `Task-A-RED-006`, `Task-A-GREEN-004` | Not Started |
| `assistant/session-entry-store.ts`                       | `control-plane/acp/session-recovery-store.ts` (新規) | ACP-SESSION-LOAD-002    | journal/snapshot/replay 実装が未着手                     | `Task-A-RED-006`, `Task-A-GREEN-004` | Not Started |
| `assistant/compaction-runtime.ts`                        | `assistant/compaction-runtime.ts` (新規)             | ACP-COMPACTION-001      | pre-compaction flush 連動未移植                          | `Task-B-RED-006`, `Task-B-GREEN-005` | Not Started |
| `assistant/markdown-summary-batch.ts`                    | `assistant/markdown-summary-batch.ts` (新規)         | ACP-SUMMARY-BATCH-001   | watermark 増分処理未移植                                 | `Task-B-RED-008`, `Task-B-GREEN-008` | Not Started |
| `assistant/memory-search/*`                              | `assistant/memory-search/*` (新規)                   | ACP-MEMORY-SEARCH-001   | `memoryScope=main` ゲート付きで再導入                    | `Task-B-RED-001`, `Task-B-GREEN-001` | Not Started |
| `assistant/memory-reader.ts`                             | `assistant/memory-reader.ts` (新規)                  | ACP-MEMORY-GET-001      | path-guard 要件を満たす再実装が必要                      | `Task-B-RED-002`, `Task-B-GREEN-006` | Not Started |
| `assistant/memory-writer.ts`                             | `assistant/memory-writer.ts` (新規)                  | ACP-MEMORY-WRITE-001    | `memoryWriteEnabled` 条件付き移植                        | `Task-B-RED-007`, `Task-B-GREEN-007` | Not Started |
| `assistant/workspace-bootstrap.ts`                       | `assistant/workspace-bootstrap.ts` (新規)            | ACP-BOOTSTRAP-001       | BOOTSTRAP context 注入未移植                             | `Task-B-RED-005`, `Task-B-GREEN-004` | Not Started |
| `assistant/agent-audit.ts`                               | `control-plane/audit/*` (新規)                       | ACP-AUDIT-001           | run/tool 監査ログの正規化が必要                          | `Task-B-RED-004`, `Task-B-GREEN-003` | Not Started |
| `sandbox/docker-bash-operations.ts`                      | `sandbox/docker-bash-operations.ts` (新規)           | ACP-SANDBOX-001         | mode 切替 + fail-closed を明示実装                       | `Task-B-RED-003`, `Task-B-GREEN-002` | Not Started |
| `runtime/runtime-config-loader.ts` (sandbox/memory 関連) | `control-plane/bootstrap/config.ts` (新規)           | ACP-CONFIG-001          | s04 必須設定の一本化が必要                               | `Task-B-REFACTOR-001`                | Not Started |
| `assistant/main.ts` (legacy 統合起動)                    | `index.ts` / `assistant/main.ts` 分離                | ACP-BOOTSTRAP-ENTRY-001 | 役割分離済み（CP: listen, worker: stdio）                | `Task-A-GREEN-000`                   | Done        |

## 補足

- Phase A/B の対象責務は上表で 100% 列挙済み。
- `collector-slack` の本移植は本計画の非スコープのため本表から除外。
