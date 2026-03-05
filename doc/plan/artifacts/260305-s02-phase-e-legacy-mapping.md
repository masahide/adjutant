# 260305-s02 Phase E: legacy -> ACP 移植マッピング

## 1. 目的

`legacy/impl-20260228` に存在する proactive / heartbeat 実装を、Phase E で `src/control-plane` 中心へ段階移植する際の責務対応表を固定する。

## 2. マッピング表

| legacy 実装                                                        | 役割                           | ACP 先（Phase E）                                                                         | 状態          |
| ------------------------------------------------------------------ | ------------------------------ | ----------------------------------------------------------------------------------------- | ------------- |
| `legacy/impl-20260228/src/proactive/rule-triage.ts`                | self/DM/mention/channel 判定   | `src/control-plane/proactive/rule-triage.ts`                                              | planned       |
| `legacy/impl-20260228/src/proactive/attention-window.ts`           | idle/maxWait 集約              | `src/control-plane/proactive/attention-window.ts`                                         | planned       |
| `legacy/impl-20260228/src/proactive/batch-classifier.ts`           | `respond/note/ignore` 判定     | `src/control-plane/proactive/batch-classifier.ts`                                         | planned       |
| `legacy/impl-20260228/src/proactive/notification-queue-service.ts` | dispatch queueing              | `src/control-plane/proactive/notification-queue-service.ts`                               | planned       |
| `legacy/impl-20260228/src/proactive/global-concurrency-queue.ts`   | source 優先度制御              | `src/control-plane/proactive/global-concurrency-queue.ts`                                 | planned       |
| `legacy/impl-20260228/src/proactive/timeline-record.ts`            | timeline schema/append 補助    | `src/control-plane/proactive/schema.ts`, `src/control-plane/proactive/timeline-store.ts`  | schema seeded |
| `legacy/impl-20260228/src/proactive/watermark-store.ts`            | watermark 永続化/更新          | `src/control-plane/proactive/schema.ts`, `src/control-plane/proactive/watermark-store.ts` | schema seeded |
| `legacy/impl-20260228/src/proactive/pending-flusher.ts`            | stale open post 回収           | `src/control-plane/proactive/pending-flusher.ts`                                          | planned       |
| `legacy/impl-20260228/src/assistant/heartbeat-runner.ts`           | periodic/manual heartbeat 実行 | `src/control-plane/heartbeat/heartbeat-runner.ts`                                         | planned       |
| `legacy/impl-20260228/src/assistant/heartbeat-result-writer.ts`    | heartbeat-runs 永続化          | `src/control-plane/heartbeat/schema.ts`, `src/control-plane/heartbeat/result-store.ts`    | schema seeded |

## 3. 受け入れ時の移植ルール

- ロジックは可能な限り責務単位で移植し、挙動差分を生む全面書き直しは避ける。
- API 境界は `src/control-plane/contracts/http-api.ts` を正本に集約し、legacy 側の暗黙契約は残さない。
- timeline/watermark/heartbeat-runs のスキーマは `schema.ts` で型ガードを提供し、読み込み時に fail-open（skip + warn）とする。
- 移植完了判定は Unit + Integration + Contract テストの 3 層が揃った時点とする。
